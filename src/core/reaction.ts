import {
    IDerivation,
    IDerivationState,
    trackDerivedFunction,
    clearObserving,
    shouldCompute,
    isCaughtException,
    TraceMode
} from "./derivation"
import { IObservable, startBatch, endBatch } from "./observable"
import { globalState } from "./globalstate"
import { createInstanceofPredicate, getNextId, Lambda } from "../utils/utils"
import { isSpyEnabled, spyReport, spyReportStart, spyReportEnd } from "./spy"
import { trace } from "../api/trace"

/**
 * Reactions are a special kind of derivations. Several things distinguishes them from normal reactive computations
 *
 * 1) They will always run, whether they are used by other computations or not.
 * This means that they are very suitable for triggering side effects like logging, updating the DOM and making network requests.
 * 2) They are not observable themselves
 * 3) They will always run after any 'normal' derivations
 * 4) They are allowed to change the state and thereby triggering themselves again, as long as they make sure the state propagates to a stable state in a reasonable amount of iterations.
 *
 * The state machine of a Reaction is as follows:
 *
 * 1) after creating, the reaction should be started by calling `runReaction` or by scheduling it (see also `autorun`)
 * 2) the `onInvalidate` handler should somehow result in a call to `this.track(someFunction)`
 * 3) all observables accessed in `someFunction` will be observed by this reaction.
 * 4) as soon as some of the dependencies has changed the Reaction will be rescheduled for another run (after the current mutation or transaction). `isScheduled` will yield true once a dependency is stale and during this period
 * 5) `onInvalidate` will be called, and we are back at step 1.
 *
 */

export interface IReactionPublic {
    dispose(): void
    trace(enterBreakPoint?: boolean): void
}

export interface IReactionDisposer {
    (): void
    $mobx: Reaction
}

export class Reaction implements IDerivation, IReactionPublic {
    observing: IObservable[] = [] // nodes we are looking at. Our value depends on these nodes
    newObserving: IObservable[] = []
    dependenciesState = IDerivationState.NOT_TRACKING
    diffValue = 0
    runId = 0
    unboundDepsCount = 0
    __mapid = "#" + getNextId()
    isDisposed = false
    _isScheduled = false
    _isTrackPending = false
    _isRunning = false
    isTracing: TraceMode = TraceMode.NONE

    // reaction = new Reaction(
    //     name, --> name
    //     () => { --> onInvalidate
    //         if (!isScheduled) {
    //             isScheduled = true
    //             scheduler(() => {
    //                 isScheduled = false
    //                 if (!reaction.isDisposed) reaction.track(reactionRunner)
    //             })
    //         }
    //     },
    //     opts.onError --> errorHandler
    // )
    constructor(
        public name: string = "Reaction@" + getNextId(),
        private onInvalidate: () => void,
        private errorHandler?: (error: any, derivation: IDerivation) => void
    ) {}

    onBecomeStale() {
        this.schedule()
    }

    schedule() {
        if (!this._isScheduled) {
            //加锁表示正在部署
            this._isScheduled = true
            //将需要执行的reaction对象入列 pendingReactions等待执行的reaction
            globalState.pendingReactions.push(this)
            //执行部署
            runReactions()
        }
    }

    isScheduled() {
        return this._isScheduled
    }

    /**
     * internal, use schedule() if you intend to kick off a reaction
     */
    runReaction() {
        if (!this.isDisposed) {
            //startBatch() 和 endBatch() 这两个方法一定是成对出现
            //用于影响 globalState 的 inBatch 属性，表明开启/关闭 一层新的事务
            //startBatch === globalState.inBatch++
            startBatch()
            this._isScheduled = false
            if (shouldCompute(this)) {
                this._isTrackPending = true
                //onInvalidate 是 Reaction 类的一个属性，且在初始化 Reaction 时传入到构造函数中的，这样做的目的是方便做扩展。
                this.onInvalidate()
                if (this._isTrackPending && isSpyEnabled()) {
                    // onInvalidate didn't trigger track right away..
                    spyReport({
                        name: this.name,
                        type: "scheduled-reaction"
                    })
                }
            }
            endBatch()
        }
    }

    //fn === reactionRunner
    track(fn: () => void) {
        startBatch()
        const notify = isSpyEnabled()
        let startTime
        if (notify) {
            startTime = Date.now()
            spyReportStart({
                name: this.name,
                type: "reaction"
            })
        }
        this._isRunning = true
        // function reactionRunner() { --> reactionRunner
        //     view(reaction)  --> view函数 就是autorun的内容
        // }
        const result = trackDerivedFunction(this, fn, undefined)
        this._isRunning = false
        this._isTrackPending = false
        if (this.isDisposed) {
            // disposed during last run. Clean up everything that was bound after the dispose call.
            clearObserving(this)
        }
        if (isCaughtException(result)) this.reportExceptionInDerivation(result.cause)
        if (notify) {
            spyReportEnd({
                time: Date.now() - startTime
            })
        }
        endBatch()
    }

    reportExceptionInDerivation(error: any) {
        if (this.errorHandler) {
            this.errorHandler(error, this)
            return
        }

        const message = `[mobx] Encountered an uncaught exception that was thrown by a reaction or observer component, in: '${this}`
        console.error(message, error)
        /** If debugging brought you here, please, read the above message :-). Tnx! */

        if (isSpyEnabled()) {
            spyReport({
                type: "error",
                name: this.name,
                message,
                error: "" + error
            })
        }

        globalState.globalReactionErrorHandlers.forEach(f => f(error, this))
    }

    dispose() {
        if (!this.isDisposed) {
            this.isDisposed = true
            if (!this._isRunning) {
                // if disposed while running, clean up later. Maybe not optimal, but rare case
                startBatch()
                clearObserving(this)
                endBatch()
            }
        }
    }

    getDisposer(): IReactionDisposer {
        const r = this.dispose.bind(this)
        r.$mobx = this
        return r
    }

    toString() {
        return `Reaction[${this.name}]`
    }

    trace(enterBreakPoint: boolean = false) {
        trace(this, enterBreakPoint)
    }
}

export function onReactionError(handler: (error: any, derivation: IDerivation) => void): Lambda {
    globalState.globalReactionErrorHandlers.push(handler)
    return () => {
        const idx = globalState.globalReactionErrorHandlers.indexOf(handler)
        if (idx >= 0) globalState.globalReactionErrorHandlers.splice(idx, 1)
    }
}

/**
 * Magic number alert!
 * Defines within how many times a reaction is allowed to re-trigger itself
 * until it is assumed that this is gonna be a never ending loop...
 */
const MAX_REACTION_ITERATIONS = 100

//reactionScheduler是一个函数变量，函数的入参是一个返回空的函数,该函数返回空 === reactionScheduler = f => f()
//reactionScheduler应该是用作规定格式规范
let reactionScheduler: (fn: () => void) => void = f => f()

export function runReactions() {
    // Trampolining, if runReactions are already running, new reactions will be picked up
    if (globalState.inBatch > 0 || globalState.isRunningReactions) return
    reactionScheduler(runReactionsHelper)
}

function runReactionsHelper() {
    globalState.isRunningReactions = true
    const allReactions = globalState.pendingReactions
    let iterations = 0

    // While running reactions, new reactions might be triggered.
    // Hence we work with two variables and check whether
    // we converge to no remaining reactions after a while.
    while (allReactions.length > 0) {
        //对reaction的总数量做限制 超过则不执行
        if (++iterations === MAX_REACTION_ITERATIONS) {
            console.error(
                `Reaction doesn't converge to a stable state after ${MAX_REACTION_ITERATIONS} iterations.` +
                    ` Probably there is a cycle in the reactive function: ${allReactions[0]}`
            )
            allReactions.splice(0) // clear reactions
        }
        //拷贝reactions到remainingReactions
        let remainingReactions = allReactions.splice(0)
        //遍历执行他们的runReaction --> runReaction
        for (let i = 0, l = remainingReactions.length; i < l; i++)
            remainingReactions[i].runReaction()
    }
    globalState.isRunningReactions = false
}

export const isReaction = createInstanceofPredicate("Reaction", Reaction)

export function setReactionScheduler(fn: (f: () => void) => void) {
    const baseScheduler = reactionScheduler
    reactionScheduler = f => fn(() => baseScheduler(f))
}
