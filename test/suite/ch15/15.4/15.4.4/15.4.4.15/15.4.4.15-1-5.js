/// Copyright (c) 2012 Ecma International.  All rights reserved. 
/// Ecma International makes this code available under the terms and conditions set
/// forth on http://hg.ecmascript.org/tests/test262/raw-file/tip/LICENSE (the 
/// "Use Terms").   Any redistribution of this code must retain the above 
/// copyright and this notice and otherwise comply with the Use Terms.
/**
 * @path ch15/15.4/15.4.4/15.4.4.15/15.4.4.15-1-5.js
 * @description Array.prototype.lastIndexOf applied to number primitive
 */


function testcase() {

        try {
                Number.prototype[1] = isNaN;
                Number.prototype.length = 2;
                return 1 === Array.prototype.lastIndexOf.call(5, isNaN);
            } finally {
                delete Number.prototype[1];
                delete Number.prototype.length;
            }
    }
runTestCase(testcase);
