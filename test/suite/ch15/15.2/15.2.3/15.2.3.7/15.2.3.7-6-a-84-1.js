/// Copyright (c) 2012 Ecma International.  All rights reserved. 
/// Ecma International makes this code available under the terms and conditions set
/// forth on http://hg.ecmascript.org/tests/test262/raw-file/tip/LICENSE (the 
/// "Use Terms").   Any redistribution of this code must retain the above 
/// copyright and this notice and otherwise comply with the Use Terms.
/**
 * @path ch15/15.2/15.2.3/15.2.3.7/15.2.3.7-6-a-84-1.js
 * @description Object.defineProperties will not throw TypeError when P.configurable is false, P.writalbe is false, properties.value and P.value are two Objects refer to the same object which has been updated before use it to update the object (8.12.9 step 10.a.ii.1)
 */


function testcase() {

        var obj = {};

        var obj1 = { length: 10 };

        Object.defineProperty(obj, "foo", {
            value: obj1,
            writable: false,
            configurable: false
        });

        var obj2 = obj1;
        obj2.y = "hello";

        Object.defineProperties(obj, {
            foo: {
                value: obj2
            }
        });
        return dataPropertyAttributesAreCorrect(obj, "foo", obj1, false, false, false);
    }
runTestCase(testcase);
