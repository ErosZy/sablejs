/// Copyright (c) 2012 Ecma International.  All rights reserved. 
/// Ecma International makes this code available under the terms and conditions set
/// forth on http://hg.ecmascript.org/tests/test262/raw-file/tip/LICENSE (the 
/// "Use Terms").   Any redistribution of this code must retain the above 
/// copyright and this notice and otherwise comply with the Use Terms.
/**
 * @path ch15/15.2/15.2.3/15.2.3.6/15.2.3.6-4-269.js
 * @description Object.defineProperty - 'O' is an Array, 'name' is an array index named property, name is accessor property and 'desc' is accessor descriptor, test setting the [[Set]] attribute value of 'name' as undefined (15.4.5.1 step 4.c)
 */


function testcase() {

        var arrObj = [];

        Object.defineProperty(arrObj, "0", {
            set: function () { },
            configurable: true
        });

        Object.defineProperty(arrObj, "0", {
            set: undefined
        });
        return accessorPropertyAttributesAreCorrect(arrObj, "0", undefined, undefined, undefined, false, true);
    }
runTestCase(testcase);
