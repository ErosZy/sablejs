// Copyright 2009 the Sputnik authors.  All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.

/**
 * Object.prototype.propertyIsEnumerable can't be used as a constructor
 *
 * @path ch15/15.2/15.2.4/15.2.4.7/S15.2.4.7_A7.js
 * @description Checking if creating "new Object.prototype.propertyIsEnumerable" fails
 */

var FACTORY = Object.prototype.propertyIsEnumerable;

try {
  instance = new FACTORY;
  $FAIL('#1: Object.prototype.propertyIsEnumerable can\'t be used as a constructor');
} catch (e) {
  $PRINT(e);

}

