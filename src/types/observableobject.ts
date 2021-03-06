import { ObservableValue, UNCHANGED } from "./observablevalue"
import { ComputedValue, IComputedValueOptions } from "../core/computedvalue"
import {
    createInstanceofPredicate,
    isObject,
    Lambda,
    getNextId,
    invariant,
    assertPropertyConfigurable,
    isPlainObject,
    fail,
    addHiddenFinalProp
} from "../utils/utils"
import {
    hasInterceptors,
    IInterceptable,
    registerInterceptor,
    interceptChange
} from "./intercept-utils"
import { IListenable, registerListener, hasListeners, notifyListeners } from "./listen-utils"
import { isSpyEnabled, spyReportStart, spyReportEnd } from "../core/spy"
import { IEnhancer, referenceEnhancer, deepEnhancer } from "./modifiers"
import { ObservableArray, IObservableArray } from "./observablearray"
import { initializeInstance } from "../utils/decorators2"
import { startBatch, endBatch } from "../core/observable"

export interface IObservableObject {
    "observable-object": IObservableObject
}

export type IObjectDidChange =
    | {
          name: string
          object: any
          type: "add"
          newValue: any
      }
    | {
          name: string
          object: any
          type: "update"
          oldValue: any
          newValue: any
      }
    | {
          name: string
          object: any
          type: "remove"
          oldValue: any
      }

export type IObjectWillChange =
    | {
          object: any
          type: "update" | "add"
          name: string
          newValue: any
      }
    | {
          object: any
          type: "remove"
          name: string
      }

export class ObservableObjectAdministration
    implements IInterceptable<IObjectWillChange>, IListenable {
    values: { [key: string]: ObservableValue<any> | ComputedValue<any> } = {}
    keys: undefined | IObservableArray<string>
    changeListeners
    interceptors

    constructor(public target: any, public name: string, public defaultEnhancer: IEnhancer<any>) {}

    read(owner: any, key: string) {
        if (this.target !== owner) {
            this.illegalAccess(owner, key)
            return
        }
        return this.values[key].get()
    }

    write(owner: any, key: string, newValue) {
        const instance = this.target
        if (instance !== owner) {
            this.illegalAccess(owner, key)
            return
        }
        const observable = this.values[key]
        if (observable instanceof ComputedValue) {
            observable.set(newValue)
            return
        }

        // intercept
        if (hasInterceptors(this)) {
            const change = interceptChange<IObjectWillChange>(this, {
                type: "update",
                object: instance,
                name: key,
                newValue
            })
            if (!change) return
            newValue = (change as any).newValue
        }
        newValue = (observable as any).prepareNewValue(newValue)

        // notify spy & observers
        if (newValue !== UNCHANGED) {
            const notify = hasListeners(this)
            const notifySpy = isSpyEnabled()
            const change =
                notify || notifySpy
                    ? {
                          type: "update",
                          object: instance,
                          oldValue: (observable as any).value,
                          name: key,
                          newValue
                      }
                    : null

            if (notifySpy) spyReportStart({ ...change, name: this.name, key })
            ;(observable as ObservableValue<any>).setNewValue(newValue)
            if (notify) notifyListeners(this, change)
            if (notifySpy) spyReportEnd()
        }
    }

    remove(key: string) {
        if (!this.values[key]) return
        const { target } = this
        if (hasInterceptors(this)) {
            const change = interceptChange<IObjectWillChange>(this, {
                object: target,
                name: key,
                type: "remove"
            })
            if (!change) return
        }
        try {
            startBatch()
            const notify = hasListeners(this)
            const notifySpy = isSpyEnabled()
            const oldValue = this.values[key].get()
            if (this.keys) this.keys.remove(key)
            delete this.values[key]
            delete this.target[key]
            const change =
                notify || notifySpy
                    ? {
                          type: "remove",
                          object: target,
                          oldValue: oldValue,
                          name: key
                      }
                    : null
            if (notifySpy) spyReportStart({ ...change, name: this.name, key })
            if (notify) notifyListeners(this, change)
            if (notifySpy) spyReportEnd()
        } finally {
            endBatch()
        }
    }

    illegalAccess(owner, propName) {
        /**
         * This happens if a property is accessed through the prototype chain, but the property was
         * declared directly as own property on the prototype.
         *
         * E.g.:
         * class A {
         * }
         * extendObservable(A.prototype, { x: 1 })
         *
         * classB extens A {
         * }
         * console.log(new B().x)
         *
         * It is unclear whether the property should be considered 'static' or inherited.
         * Either use `console.log(A.x)`
         * or: decorate(A, { x: observable })
         *
         * When using decorate, the property will always be redeclared as own property on the actual instance
         */
        return fail(
            `Property '${propName}' of '${owner}' was accessed through the prototype chain. Use 'decorate' instead to declare the prop or access it statically through it's owner`
        )
    }

    /**
     * Observes this object. Triggers for the events 'add', 'update' and 'delete'.
     * See: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/observe
     * for callback details
     */
    observe(callback: (changes: IObjectDidChange) => void, fireImmediately?: boolean): Lambda {
        process.env.NODE_ENV !== "production" &&
            invariant(
                fireImmediately !== true,
                "`observe` doesn't support the fire immediately property for observable objects."
            )
        return registerListener(this, callback)
    }

    intercept(handler): Lambda {
        return registerInterceptor(this, handler)
    }

    getKeys(): string[] {
        if (this.keys === undefined) {
            this.keys = <any>new ObservableArray(
                Object.keys(this.values).filter(key => this.values[key] instanceof ObservableValue),
                referenceEnhancer,
                `keys(${this.name})`,
                true
            )
        }
        return this.keys!.slice()
    }
}

export interface IIsObservableObject {
    $mobx: ObservableObjectAdministration
}

//给target挂载上$mobx属性 $mobx属性是一个ObservableObjectAdministration对象
export function asObservableObject(
    target, // {}
    name: string = "",
    defaultEnhancer: IEnhancer<any> = deepEnhancer
): ObservableObjectAdministration {
    //已经有$mobx属性 return
    let adm = (target as any).$mobx
    if (adm) return adm

    process.env.NODE_ENV !== "production" &&
        invariant(
            Object.isExtensible(target),
            "Cannot make the designated object observable; it is not extensible"
        )
    if (!isPlainObject(target))
        name = (target.constructor.name || "ObservableObject") + "@" + getNextId()
    if (!name) name = "ObservableObject@" + getNextId()
    //target是一个空的对象 上面有$mobx属性 === adm
    //$mobx 属性是一个 ObservableObjectAdministration 对象
    adm = new ObservableObjectAdministration(target, name, defaultEnhancer)
    //addHiddenFinalProp 是一个 Object.defineProperty, 用于把$mobx属性添加到target上去 内容为adm
    addHiddenFinalProp(target, "$mobx", adm)
    // --> {
    //     $mobx: adm = new ObservableObjectAdministration(target, name, defaultEnhancer)
    // }
    return adm
}

export function defineObservableProperty(
    target: any,
    propName: string,
    newValue,
    enhancer: IEnhancer<any>
) {
    //给target挂载上$mobx属性 $mobx属性是一个ObservableObjectAdministration对象
    const adm = asObservableObject(target)
    assertPropertyConfigurable(target, propName)

    if (hasInterceptors(adm)) {
        const change = interceptChange<IObjectWillChange>(adm, {
            object: target,
            name: propName,
            type: "add",
            newValue
        })
        if (!change) return
        newValue = (change as any).newValue
    }

    //这里的adm就是 $mobx属性，这样新生成的ObservableValue 实例就挂载在 $mobx.values[propName] 属性下
    const observable = (adm.values[propName] = new ObservableValue(
        newValue,
        enhancer,
        `${adm.name}.${propName}`,
        false
    ))
    newValue = (observable as any).value // observableValue might have changed it

    //把属性挂载上
    Object.defineProperty(target, propName, generateObservablePropConfig(propName))
    if (adm.keys) adm.keys.push(propName)
    notifyPropertyAddition(adm, target, propName, newValue)
}

export function defineComputedProperty(
    target: any, // which objects holds the observable and provides `this` context?
    propName: string,
    options: IComputedValueOptions<any>
) {
    const adm = asObservableObject(target)
    options.name = `${adm.name}.${propName}`
    options.context = target
    adm.values[propName] = new ComputedValue(options)
    Object.defineProperty(target, propName, generateComputedPropConfig(propName))
}

const observablePropertyConfigs = {}
const computedPropertyConfigs = {}

//该方法是作用在 decorator 装饰器其作用期间，用 generateObservablePropConfig
//生成的描述符重写原始对象的描述符，仔细看描述符里的 get 和 set 方法，
//对象属性的 读写分别映射到 $mobx.read 和 $mobx.write这两个方法中。
export function generateObservablePropConfig(propName) {
    return (
        observablePropertyConfigs[propName] ||
        (observablePropertyConfigs[propName] = {
            configurable: true,
            enumerable: true,
            get() {
                return this.$mobx.read(this, propName)
            },
            set(v) {
                this.$mobx.write(this, propName, v)
            }
        })
    )
}

function getAdministrationForComputedPropOwner(owner: any): ObservableObjectAdministration {
    const adm = owner.$mobx
    if (!adm) {
        // because computed props are declared on proty,
        // the current instance might not have been initialized yet
        initializeInstance(owner)
        return owner.$mobx
    }
    return adm
}

export function generateComputedPropConfig(propName) {
    return (
        computedPropertyConfigs[propName] ||
        (computedPropertyConfigs[propName] = {
            configurable: true,
            enumerable: false,
            get() {
                return getAdministrationForComputedPropOwner(this).read(this, propName)
            },
            set(v) {
                getAdministrationForComputedPropOwner(this).write(this, propName, v)
            }
        })
    )
}

function notifyPropertyAddition(
    adm: ObservableObjectAdministration,
    object,
    key: string,
    newValue
) {
    const notify = hasListeners(adm)
    const notifySpy = isSpyEnabled()
    const change =
        notify || notifySpy
            ? {
                  type: "add",
                  object,
                  name: key,
                  newValue
              }
            : null

    if (notifySpy) spyReportStart({ ...change, name: adm.name, key })
    if (notify) notifyListeners(adm, change)
    if (notifySpy) spyReportEnd()
}

const isObservableObjectAdministration = createInstanceofPredicate(
    "ObservableObjectAdministration",
    ObservableObjectAdministration
)

export function isObservableObject(thing: any): thing is IObservableObject {
    if (isObject(thing)) {
        // Initializers run lazily when transpiling to babel, so make sure they are run...
        initializeInstance(thing)
        return isObservableObjectAdministration((thing as any).$mobx)
    }
    return false
}
