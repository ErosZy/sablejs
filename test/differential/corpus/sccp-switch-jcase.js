function testSwitchTryAndJoins(flag, probeValue) {
  var r = [];
  try {
    switch (0) {
      case 0:
        r.push(1);
    }
  } catch (e) {
    r.push(99);
  }
  try {
    switch (0) {
      case 0:
        r.push(2);
        break;
    }
  } finally {
    r.push(3);
  }
  if (flag) {
    switch (0) {
      case 0:
        r.push(4);
    }
  }
  switch (0) {
    case 1:
      r.push(10);
    case 0:
      r.push(11);
    case 2:
      r.push(12);
    default:
      r.push(13);
  }
  switch (0) {
    case probeValue:
      r.push(20);
    case 0:
      r.push(21);
  }
  return r;
}

function testSwitchReturnInTryFinally() {
  var r = [];
  try {
    switch (0) {
      case 0:
        r.push(1);
        return r;
    }
  } finally {
    r.push(2);
  }
}

function testBreakInNestedTryFinally() {
  var r = [];
  switch (0) {
    case 0:
      try {
        r.push(1);
        break;
      } finally {
        r.push(2);
      }
      r.push(3);
  }
  return r;
}

function testDenseSwitchWithCaseTestGVN() {
  var v1 = 9;
  var v2 = 0;
  var v3 = 1;
  switch (v1) {
    case v2:
      v3 = v2;
      break;
    case false:
      v2 = 7;
      break;
  }
  var v0 = false;
  var a = 1;
  var b = 2;
  switch (true) {
    case v0:
      b = 3;
    case 3:
      b = 4;
    default:
      a = v0;
  }
  return [v3, a, b];
}

JSON.stringify({
  t0: testSwitchTryAndJoins(true, 0),
  t1: testSwitchTryAndJoins(false, 1),
  ret: testSwitchReturnInTryFinally(),
  brk: testBreakInNestedTryFinally(),
  gvn: testDenseSwitchWithCaseTestGVN(),
});
