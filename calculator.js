/**
 * SciCalc — Scientific Calculator Engine
 * Architecture: Pure functional core + thin UI controller layer
 * Handles: expression building, safe evaluation, angle modes,
 *          memory, history, keyboard, and accessibility.
 */

'use strict';

/* ============================================================
   1. CONSTANTS & CONFIGURATION
   ============================================================ */
const MAX_HISTORY   = 20;
const MAX_EXPR_LEN  = 120;
const MAX_RESULT_DP = 10;   // max decimal places displayed

/* ============================================================
   2. MATH ENGINE — pure, no DOM
   ============================================================ */
const MathEngine = (() => {

  /** Convert trig input based on current angle mode */
  function toRad(x, mode) {
    return mode === 'deg' ? x * Math.PI / 180 : x;
  }

  /** Convert asin/acos/atan output to current angle mode */
  function fromRad(x, mode) {
    return mode === 'deg' ? x * 180 / Math.PI : x;
  }

  /** Factorial — integer only, returns NaN for invalid inputs */
  function factorial(n) {
    n = Math.round(n);
    if (n < 0 || n > 170) return NaN;
    if (n <= 1) return 1;
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return r;
  }

  /**
   * Safe expression evaluator.
   * Rewrites the expression string into a safe JS expression
   * using a whitelist approach — never uses raw eval on user input.
   */
  function evaluate(exprRaw, mode) {
    if (!exprRaw || !exprRaw.trim()) return null;

    // Step 1: normalise operators
    let expr = exprRaw
      .replace(/×/g, '*')
      .replace(/÷/g, '/')
      .replace(/−/g, '-')
      .replace(/\^/g, '**');

    // Step 2: balance parentheses (append missing closing parens)
    const openCount  = (expr.match(/\(/g) || []).length;
    const closeCount = (expr.match(/\)/g) || []).length;
    if (openCount > closeCount) expr += ')'.repeat(openCount - closeCount);

    // Step 3: validate character whitelist (prevents code injection)
    const allowed = /^[\d\s\+\-\*\/\.\(\)\%\*]+$/;
    if (!allowed.test(expr)) return NaN;

    // Step 4: safe evaluation via Function constructor with restricted scope
    try {
      // eslint-disable-next-line no-new-func
      const result = new Function('"use strict"; return (' + expr + ')')();
      if (typeof result !== 'number') return NaN;
      return result;
    } catch {
      return NaN;
    }
  }

  /**
   * Apply a named function to the current number value.
   * Returns { value, expressionPrefix } or null on error.
   */
  function applyFunction(fnName, value, mode) {
    const v = parseFloat(value);
    if (isNaN(v)) return { value: NaN };

    let result;
    switch (fnName) {
      case 'sin':   result = Math.sin(toRad(v, mode));      break;
      case 'cos':   result = Math.cos(toRad(v, mode));      break;
      case 'tan':   result = Math.tan(toRad(v, mode));      break;
      case 'asin':  result = fromRad(Math.asin(v), mode);   break;
      case 'acos':  result = fromRad(Math.acos(v), mode);   break;
      case 'atan':  result = fromRad(Math.atan(v), mode);   break;
      case 'sinh':  result = Math.sinh(v);                   break;
      case 'cosh':  result = Math.cosh(v);                   break;
      case 'tanh':  result = Math.tanh(v);                   break;
      case 'sqrt':  result = Math.sqrt(v);                   break;
      case 'cbrt':  result = Math.cbrt(v);                   break;
      case 'sq':    result = v * v;                          break;
      case 'cube':  result = v * v * v;                      break;
      case 'log':   result = Math.log10(v);                  break;
      case 'ln':    result = Math.log(v);                    break;
      case 'log2':  result = Math.log2(v);                   break;
      case 'exp':   result = Math.exp(v);                    break;
      case '10x':   result = Math.pow(10, v);                break;
      case 'abs':   result = Math.abs(v);                    break;
      case 'recip': result = 1 / v;                          break;
      case 'fact':  result = factorial(v);                   break;
      case 'floor': result = Math.floor(v);                  break;
      case 'ceil':  result = Math.ceil(v);                   break;
      default: return { value: NaN };
    }
    return { value: result };
  }

  /** Format a numeric result for display */
  function format(n) {
    if (n === null || n === undefined) return '';
    if (isNaN(n)) return 'Error';
    if (!isFinite(n)) return n > 0 ? '∞' : '-∞';

    // If integer-valued and not too large, show as integer
    if (Number.isInteger(n) && Math.abs(n) < 1e15) {
      return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
    }

    // Use toPrecision for very large/small numbers
    if (Math.abs(n) >= 1e15 || (Math.abs(n) < 1e-7 && n !== 0)) {
      return n.toExponential(6).replace(/\.?0+e/, 'e');
    }

    // Round to MAX_RESULT_DP decimal places, trim trailing zeros
    const rounded = parseFloat(n.toFixed(MAX_RESULT_DP));
    return rounded.toLocaleString('en-US', {
      maximumFractionDigits: MAX_RESULT_DP,
      useGrouping: true,
    });
  }

  return { evaluate, applyFunction, format, toRad, fromRad };
})();


/* ============================================================
   3. CALCULATOR STATE MACHINE
   ============================================================ */
const CalcState = (() => {
  let state = createInitialState();

  function createInitialState() {
    return {
      expression:    '',    // display expression (raw, human-readable)
      evalExpr:      '',    // machine expression sent to evaluator
      result:        null,
      lastResult:    null,  // stored to chain calculations
      memory:        0,
      history:       [],
      angleMode:     'deg',
      justEvaluated: false, // flag: last action was = press
    };
  }

  function getState() { return { ...state }; }

  function reset() { state = createInitialState(); }

  function setAngleMode(mode) { state.angleMode = mode; }

  /* --- Expression building helpers --- */

  function appendDigit(digit) {
    if (state.justEvaluated) {
      // After =, if user types a digit, start fresh
      state.expression = '';
      state.evalExpr   = '';
      state.result     = null;
      state.justEvaluated = false;
    }
    if (state.expression.length >= MAX_EXPR_LEN) return;
    state.expression += digit;
    state.evalExpr   += digit;
    _liveEvaluate();
  }

  function appendDecimal() {
    // Only add decimal if last token doesn't already contain one
    const lastNum = state.expression.match(/[\d\.]+$/);
    if (lastNum && lastNum[0].includes('.')) return;
    if (state.justEvaluated) {
      state.expression = '0';
      state.evalExpr   = '0';
      state.justEvaluated = false;
    }
    if (!state.expression || /[\+\-\*\/\%\(]$/.test(state.expression)) {
      state.expression += '0';
      state.evalExpr   += '0';
    }
    state.expression += '.';
    state.evalExpr   += '.';
    _liveEvaluate();
  }

  function appendOperator(op) {
    state.justEvaluated = false;
    if (!state.expression) {
      // Allow leading minus
      if (op === '-') {
        state.expression = '-';
        state.evalExpr   = '-';
      }
      return;
    }
    // Replace trailing operator if present
    if (/[\+\-\*\/\%\^]$/.test(state.expression)) {
      state.expression = state.expression.slice(0, -1) + op;
      state.evalExpr   = state.evalExpr.slice(0, -1) + op;
    } else {
      state.expression += op;
      state.evalExpr   += op;
    }
    state.result = null;
  }

  function appendParen(p) {
    state.justEvaluated = false;
    state.expression += p;
    state.evalExpr   += p;
    _liveEvaluate();
  }

  function applyFn(fnName) {
    const currentNumStr = _extractCurrentNumber();
    if (!currentNumStr) return;

    const { value } = MathEngine.applyFunction(fnName, currentNumStr, state.angleMode);
    const resultStr = MathEngine.format(value);

    // Replace current number in expression with function application
    const fnDisplay = _fnLabel(fnName);
    const beforeNum = state.expression.slice(0, state.expression.length - currentNumStr.length);
    state.expression = beforeNum + fnDisplay + '(' + currentNumStr + ')';
    state.evalExpr   = beforeNum + String(value);
    state.result     = value;
    state.justEvaluated = false;
    _liveEvaluate();
  }

  function appendConstant(val) {
    const numVal = eval(val); // safe: val is hardcoded, never user input
    const display = val === 'Math.PI' ? 'π' : 'e';
    if (state.justEvaluated) {
      state.expression = display;
      state.evalExpr   = String(numVal);
      state.justEvaluated = false;
    } else {
      state.expression += display;
      state.evalExpr   += String(numVal);
    }
    _liveEvaluate();
  }

  function toggleSign() {
    const num = _extractCurrentNumber();
    if (!num) return;
    const toggled = num.startsWith('-') ? num.slice(1) : '-' + num;
    const before = state.expression.slice(0, state.expression.length - num.length);
    state.expression = before + toggled;
    state.evalExpr   = before + toggled;
    _liveEvaluate();
  }

  function backspace() {
    if (state.justEvaluated) {
      state.expression = '';
      state.evalExpr   = '';
      state.result     = null;
      state.justEvaluated = false;
      return;
    }
    state.expression = state.expression.slice(0, -1);
    state.evalExpr   = state.evalExpr.slice(0, -1);
    _liveEvaluate();
  }

  function clearAll() {
    state.expression    = '';
    state.evalExpr      = '';
    state.result        = null;
    state.justEvaluated = false;
  }

  function evaluate() {
    const expr = state.evalExpr;
    if (!expr) return false;

    const result = MathEngine.evaluate(expr, state.angleMode);
    const formatted = MathEngine.format(result);

    // Record in history
    if (!isNaN(result) && result !== null) {
      state.history.unshift({
        expr:    state.expression,
        result:  formatted,
      });
      if (state.history.length > MAX_HISTORY) {
        state.history.pop();
      }
      state.lastResult    = result;
    }

    state.result        = result;
    state.justEvaluated = true;
    return true;
  }

  /* Memory operations */
  function memStore()  { state.memory = state.result ?? _numericCurrent(); }
  function memRecall() {
    const m = String(state.memory);
    if (state.justEvaluated) {
      state.expression = m;
      state.evalExpr   = m;
      state.justEvaluated = false;
    } else {
      state.expression += m;
      state.evalExpr   += m;
    }
    _liveEvaluate();
  }
  function memAdd()    { state.memory += (state.result ?? _numericCurrent() ?? 0); }
  function memClear()  { state.memory = 0; }
  function getMemory() { return state.memory; }

  /* --- Private helpers --- */

  function _numericCurrent() {
    const m = state.expression.match(/-?[\d\.]+$/);
    return m ? parseFloat(m[0]) : 0;
  }

  function _extractCurrentNumber() {
    const m = state.expression.match(/-?[\d\.]+$/);
    return m ? m[0] : null;
  }

  function _liveEvaluate() {
    // Show live preview result while typing
    const r = MathEngine.evaluate(state.evalExpr, state.angleMode);
    if (r !== null && !isNaN(r) && isFinite(r)) {
      state.result = r;
    } else {
      state.result = null;
    }
  }

  function _fnLabel(fn) {
    const labels = {
      sin: 'sin', cos: 'cos', tan: 'tan',
      asin: 'sin⁻¹', acos: 'cos⁻¹', atan: 'tan⁻¹',
      sinh: 'sinh', cosh: 'cosh', tanh: 'tanh',
      sqrt: '√', cbrt: '∛', sq: '²', cube: '³',
      log: 'log', ln: 'ln', log2: 'log₂',
      exp: 'e^', '10x': '10^', abs: '|', recip: '1/',
      fact: '', floor: '⌊', ceil: '⌈',
    };
    return labels[fn] || fn;
  }

  return {
    getState, reset, setAngleMode,
    appendDigit, appendDecimal, appendOperator,
    appendParen, applyFn, appendConstant,
    toggleSign, backspace, clearAll, evaluate,
    memStore, memRecall, memAdd, memClear, getMemory,
  };
})();


/* ============================================================
   4. UI CONTROLLER — all DOM interaction
   ============================================================ */
const UIController = (() => {

  /* --- DOM refs --- */
  const elExpression = document.getElementById('display-expression');
  const elResult     = document.getElementById('display-result');
  const elHistory    = document.getElementById('history-scroll');
  const elBtnDeg     = document.getElementById('btn-deg');
  const elBtnRad     = document.getElementById('btn-rad');
  const elToast      = document.getElementById('toast');

  let toastTimeout = null;

  /* --- Render --- */
  function render() {
    const s = CalcState.getState();

    elExpression.textContent = s.expression || '';

    const formatted = MathEngine.format(s.result);

    if (s.justEvaluated) {
      elResult.textContent = formatted || s.expression;
      elResult.classList.toggle('result--error', formatted === 'Error');
      elResult.classList.remove('result--flash');
      // Force reflow to retrigger animation
      void elResult.offsetWidth;
      elResult.classList.add('result--flash');
    } else {
      // Live preview: show result only when it differs from expression
      if (s.result !== null && s.expression) {
        elResult.textContent = formatted;
      } else {
        elResult.textContent = '';
      }
      elResult.classList.remove('result--error', 'result--flash');
    }

    renderHistory(s.history);
  }

  function renderHistory(history) {
    elHistory.innerHTML = '';
    // Show last 3 items
    const slice = history.slice(0, 3).reverse();
    slice.forEach(item => {
      const line = document.createElement('div');
      line.className = 'history-line';
      line.innerHTML =
        `<span class="hist-expr">${escHtml(item.expr)}</span>` +
        `<span class="hist-result"> = ${escHtml(item.result)}</span>`;
      elHistory.appendChild(line);
    });
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /* --- Toast --- */
  function showToast(msg, duration = 2000) {
    elToast.textContent = msg;
    elToast.classList.add('toast--visible');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      elToast.classList.remove('toast--visible');
    }, duration);
  }

  /* --- Angle mode --- */
  function setAngleMode(mode) {
    CalcState.setAngleMode(mode);
    elBtnDeg.classList.toggle('active', mode === 'deg');
    elBtnRad.classList.toggle('active', mode === 'rad');
    elBtnDeg.setAttribute('aria-pressed', mode === 'deg');
    elBtnRad.setAttribute('aria-pressed', mode === 'rad');
    showToast(mode === 'deg' ? 'Degrees mode' : 'Radians mode');
  }

  /* --- Key press visual feedback --- */
  function flashKey(el) {
    el.classList.add('key--pressed');
    setTimeout(() => el.classList.remove('key--pressed'), 120);
  }

  /* --- Dispatch action from data attributes --- */
  function dispatchAction(action, dataset) {
    switch (action) {
      case 'digit':
        CalcState.appendDigit(dataset.val); break;
      case 'decimal':
        CalcState.appendDecimal(); break;
      case 'operator':
        CalcState.appendOperator(dataset.val); break;
      case 'paren':
        CalcState.appendParen(dataset.val); break;
      case 'fn':
        CalcState.applyFn(dataset.fn); break;
      case 'constant':
        CalcState.appendConstant(dataset.val); break;
      case 'sign-toggle':
        CalcState.toggleSign(); break;
      case 'backspace':
        CalcState.backspace(); break;
      case 'clear-all':
        CalcState.clearAll(); break;
      case 'evaluate':
        CalcState.evaluate(); break;
      case 'mem-store':
        CalcState.memStore();
        showToast('Stored → M = ' + MathEngine.format(CalcState.getMemory()));
        break;
      case 'mem-recall':
        CalcState.memRecall();
        showToast('Recalled M = ' + MathEngine.format(CalcState.getMemory()));
        break;
      case 'mem-add':
        CalcState.memAdd();
        showToast('M + result = ' + MathEngine.format(CalcState.getMemory()));
        break;
      case 'mem-clear':
        CalcState.memClear();
        showToast('Memory cleared');
        break;
      default:
        console.warn('Unknown action:', action);
    }
    render();
  }

  /* --- Event binding --- */
  function init() {
    // Button clicks
    document.querySelectorAll('.key').forEach(btn => {
      btn.addEventListener('click', (e) => {
        flashKey(btn);
        dispatchAction(btn.dataset.action, btn.dataset);
      });
    });

    // Angle mode toggle
    document.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => setAngleMode(btn.dataset.mode));
    });

    // Keyboard support
    document.addEventListener('keydown', handleKeyboard);

    // Initial render
    render();
  }

  /* --- Keyboard mapping --- */
  function handleKeyboard(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const key = e.key;

    // Prevent page scroll on space/arrow, etc.
    if ([' ', 'ArrowLeft', 'ArrowRight'].includes(key)) e.preventDefault();

    let action = null, dataset = {};

    if (/^[0-9]$/.test(key)) {
      action = 'digit'; dataset.val = key;
    } else if (key === '.') {
      action = 'decimal';
    } else if (key === '+') {
      action = 'operator'; dataset.val = '+';
    } else if (key === '-') {
      action = 'operator'; dataset.val = '-';
    } else if (key === '*') {
      action = 'operator'; dataset.val = '*';
    } else if (key === '/') {
      e.preventDefault();
      action = 'operator'; dataset.val = '/';
    } else if (key === '%') {
      action = 'operator'; dataset.val = '%';
    } else if (key === '^') {
      action = 'operator'; dataset.val = '^';
    } else if (key === '(' || key === ')') {
      action = 'paren'; dataset.val = key;
    } else if (key === 'Enter' || key === '=') {
      e.preventDefault();
      action = 'evaluate';
    } else if (key === 'Backspace') {
      action = 'backspace';
    } else if (key === 'Escape' || key === 'Delete') {
      action = 'clear-all';
    } else if (key === 'd' || key === 'D') {
      setAngleMode('deg'); return;
    } else if (key === 'r' || key === 'R') {
      setAngleMode('rad'); return;
    }

    if (action) {
      dispatchAction(action, dataset);
      _highlightKeyboardKey(action, dataset);
    }
  }

  function _highlightKeyboardKey(action, dataset) {
    let selector = '';
    if (action === 'digit')    selector = `[data-action="digit"][data-val="${dataset.val}"]`;
    if (action === 'decimal')  selector = `[data-action="decimal"]`;
    if (action === 'operator') selector = `[data-action="operator"][data-val="${dataset.val}"]`;
    if (action === 'evaluate') selector = `[data-action="evaluate"]`;
    if (action === 'backspace') selector = `[data-action="backspace"]`;
    if (action === 'clear-all') selector = `[data-action="clear-all"]`;
    if (action === 'paren')    selector = `[data-action="paren"][data-val="${dataset.val}"]`;

    if (selector) {
      const el = document.querySelector(selector);
      if (el) flashKey(el);
    }
  }

  return { init, render, showToast };
})();


/* ============================================================
   5. BOOTSTRAP
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  UIController.init();
});
