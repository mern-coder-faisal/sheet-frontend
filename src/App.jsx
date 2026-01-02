import React, { useState, useEffect, useRef } from 'react';
import { Plus, LogOut, UserPlus, Save, FileSpreadsheet, Menu, X, Edit2, Check } from 'lucide-react';
import io from 'socket.io-client';

// API calls (server-backed)
const API = {
  login: async (email, password) => {
    await new Promise(resolve => setTimeout(resolve, 500));
    const adminEmail = 'admin@123';
    const defaultPassword = 'Easin@2@#$';
    const storedPassword = localStorage.getItem('adminPassword') || defaultPassword;
    if (email !== adminEmail || password !== storedPassword) {
      // Only admin allowed to log in
      throw new Error('Only admin can log in.');
    }
    return { token: 'mock-token', user: { email, isAdmin: true } };
  },
  register: async (email, password) => {
    await new Promise(resolve => setTimeout(resolve, 500));
    // Registration disabled — only admin account allowed
    throw new Error('Registration disabled. Only admin account can be used.');
  },
  getSheets: async () => {
    try {
      const res = await fetch('https://easin-google-sheet.onrender.com/api/sheets');
      if (!res.ok) throw new Error('fetch failed');
      return await res.json();
    } catch (e) {
      // fallback to localStorage
      const stored = localStorage.getItem('sheets');
      return stored ? JSON.parse(stored) : [{ id: '1', name: 'Sheet1', data: {}, columnWidths: {}, rowHeights: {} }];
    }
  },
  saveSheets: async (sheets) => {
    try {
      await fetch('https://easin-google-sheet.onrender.com/api/sheets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sheets)
      });
      return { success: true };
    } catch (e) {
      localStorage.setItem('sheets', JSON.stringify(sheets));
      return { success: false };
    }
  }
};

// Formula / evaluation helpers
const CELL_REF_REGEX = /([A-Z]+)([0-9]+)/g;

const colRowToKey = (col, row) => `${getColumnLetter(col)}${row + 1}`;

const expandRange = (rangeStr) => {
  // e.g., A1:B2
  const parts = rangeStr.split(':');
  if (parts.length !== 2) return [rangeStr];
  const [start, end] = parts;
  const startMatch = start.match(/([A-Z]+)([0-9]+)/);
  const endMatch = end.match(/([A-Z]+)([0-9]+)/);
  if (!startMatch || !endMatch) return [rangeStr];

  const colToIndex = (col) => col.split('').reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
  const startCol = colToIndex(startMatch[1]);
  const startRow = parseInt(startMatch[2], 10) - 1;
  const endCol = colToIndex(endMatch[1]);
  const endRow = parseInt(endMatch[2], 10) - 1;

  const cols = [Math.min(startCol, endCol), Math.max(startCol, endCol)];
  const rows = [Math.min(startRow, endRow), Math.max(startRow, endRow)];

  const keys = [];
  for (let r = rows[0]; r <= rows[1]; r++) {
    for (let c = cols[0]; c <= cols[1]; c++) {
      keys.push(`${getColumnLetter(c)}${r + 1}`);
    }
  }
  return keys;
};

const splitTopLevelArgs = (str) => {
  const args = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      args.push(str.substring(last, i).trim());
      last = i + 1;
    }
  }
  args.push(str.substring(last).trim());
  return args.filter(a => a.length > 0);
};

const getRefsFromFormula = (formula) => {
  // returns array of cellKeys referenced (expands ranges)
  const refs = new Set();
  if (!formula || !formula.startsWith('=')) return [];
  const body = formula.substring(1);

  // function style: NAME(arg1,arg2)
  const funcMatch = body.match(/^([A-Za-z]+)\((.*)\)$/s);
  if (funcMatch) {
    const argsStr = funcMatch[2];
    const args = splitTopLevelArgs(argsStr);
    args.forEach(arg => {
      // if range
      if (arg.includes(':')) {
        expandRange(arg).forEach(k => refs.add(k));
      } else {
        // find single cell refs inside
        let m;
        while ((m = CELL_REF_REGEX.exec(arg)) !== null) {
          refs.add(`${m[1]}${m[2]}`);
        }
      }
    });
    return Array.from(refs);
  }

  // fallback: find all cell refs in expression
  let m;
  while ((m = CELL_REF_REGEX.exec(body)) !== null) {
    refs.add(`${m[1]}${m[2]}`);
  }
  return Array.from(refs);
};

const isNumeric = (v) => typeof v === 'number' || (!isNaN(parseFloat(v)) && isFinite(v));

const evaluateCellRecursive = (cellKey, sheet, computingStack = new Set(), cache = {}) => {
  if (cache[cellKey] !== undefined) return cache[cellKey];
  if (computingStack.has(cellKey)) {
    cache[cellKey] = '#CIRC!';
    return cache[cellKey];
  }

  computingStack.add(cellKey);
  const raw = sheet.data?.[cellKey] ?? '';
  if (!raw || !raw.toString().startsWith('=')) {
    cache[cellKey] = raw === undefined ? '' : raw;
    computingStack.delete(cellKey);
    return cache[cellKey];
  }

  const body = raw.toString().substring(1).trim();

  // Function call (e.g., SUM(...))
  const funcMatch = body.match(/^([A-Za-z]+)\((.*)\)$/s);
  if (funcMatch) {
    const fname = funcMatch[1].toUpperCase();
    const argsStr = funcMatch[2];
    const args = splitTopLevelArgs(argsStr);

    const collectRangeValues = (arg) => {
      const vals = [];
      if (arg.includes(':')) {
        expandRange(arg).forEach(k => {
          const v = evaluateCellRecursive(k, sheet, computingStack, cache);
          vals.push(v);
        });
      } else {
        // Could be a number, cell ref, or expression
        const m = arg.match(/^([A-Za-z]+)([0-9]+)$/);
        if (m) {
          vals.push(evaluateCellRecursive(`${m[1]}${m[2]}`, sheet, computingStack, cache));
        } else {
          // try to evaluate as expression or number
          // replace cell refs in the arg
          let expr = arg;
          expr = expr.replace(CELL_REF_REGEX, (match, col, row) => {
            const key = `${col}${row}`;
            const v = evaluateCellRecursive(key, sheet, computingStack, cache);
            return isNumeric(v) ? String(parseFloat(v)) : '0';
          });
          try {
            const v = eval(expr);
            vals.push(v);
          } catch (e) {
            vals.push('#ERROR');
          }
        }
      }
      return vals;
    };

    const numericVals = [];
    const nonEmptyVals = [];

    args.forEach(arg => {
      const vals = collectRangeValues(arg);
      vals.forEach(v => {
        if (v !== '' && v !== undefined && v !== null) nonEmptyVals.push(v);
        if (isNumeric(v)) numericVals.push(Number(v));
      });
    });

    let out;
    switch (fname) {
      case 'SUM':
        out = numericVals.reduce((a, b) => a + b, 0);
        break;
      case 'COUNT':
        out = numericVals.length;
        break;
      case 'COUNTA':
        out = nonEmptyVals.length;
        break;
      case 'AVERAGE':
        if (numericVals.length === 0) out = '#DIV/0!';
        else out = numericVals.reduce((a, b) => a + b, 0) / numericVals.length;
        break;
      case 'MIN':
        if (numericVals.length === 0) out = '#NUM!';
        else out = Math.min(...numericVals);
        break;
      case 'MAX':
        if (numericVals.length === 0) out = '#NUM!';
        else out = Math.max(...numericVals);
        break;
      default:
        out = '#NAME?';
    }

    cache[cellKey] = (typeof out === 'number') ? String(out) : out;
    computingStack.delete(cellKey);
    return cache[cellKey];
  }

  // Fallback: arithmetic expression - replace cell refs with numeric value (non-numeric -> 0)
  try {
    let expr = body.replace(CELL_REF_REGEX, (match, col, row) => {
      const key = `${col}${row}`;
      const v = evaluateCellRecursive(key, sheet, computingStack, cache);
      return isNumeric(v) ? String(parseFloat(v)) : '0';
    });
    const result = eval(expr);
    cache[cellKey] = (typeof result === 'number') ? String(result) : String(result);
  } catch (e) {
    cache[cellKey] = '#ERROR';
  }
  computingStack.delete(cellKey);
  return cache[cellKey];
};

const buildDependenciesForCell = (cellKey, sheet) => {
  const refs = getRefsFromFormula(sheet.data?.[cellKey] ?? '');
  sheet.deps = sheet.deps || {};
  sheet.revDeps = sheet.revDeps || {};

  // clear previous deps for cellKey
  Object.keys(sheet.revDeps).forEach(ref => {
    sheet.revDeps[ref] = new Set(Array.from(sheet.revDeps[ref]));
    sheet.revDeps[ref].delete(cellKey);
    if (sheet.revDeps[ref].size === 0) delete sheet.revDeps[ref];
  });

  sheet.deps[cellKey] = new Set(refs);
  refs.forEach(r => {
    sheet.revDeps[r] = sheet.revDeps[r] || new Set();
    sheet.revDeps[r].add(cellKey);
  });
};

const recomputeSheet = (sheet) => {
  sheet.computed = sheet.computed || {};
  const cache = {};
  const allKeys = new Set([...Object.keys(sheet.data || {})]);
  // ensure we also compute any referenced cells even if empty
  Object.keys(sheet.data || {}).forEach(k => {
    const refs = getRefsFromFormula(sheet.data[k]);
    refs.forEach(r => allKeys.add(r));
  });

  allKeys.forEach(k => {
    evaluateCellRecursive(k, sheet, new Set(), cache);
  });

  // write cache to computed as strings
  sheet.computed = {};
  Object.keys(cache).forEach(k => { sheet.computed[k] = cache[k]; });
};

// NOTE: updateCellAndRecalculate moved into the App component to access React state (`sheets`, `setSheets`)

const getColumnLetter = (index) => {
  let letter = '';
  while (index >= 0) {
    letter = String.fromCharCode(65 + (index % 26)) + letter;
    index = Math.floor(index / 26) - 1;
  }
  return letter;
};

function App() {
  const [user, setUser] = useState(null);
  const [showLogin, setShowLogin] = useState(true);
  const [showRegister, setShowRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sheets, setSheets] = useState([]);
  const [activeSheetId, setActiveSheetId] = useState(null);
  const [selectedCells, setSelectedCells] = useState([]);
  const [editingCell, setEditingCell] = useState(null);
  const [cellInput, setCellInput] = useState('');
  const [shiftPressed, setShiftPressed] = useState(false);
  const [showSheetList, setShowSheetList] = useState(false);
  const [editingSheetId, setEditingSheetId] = useState(null);
  const [sheetNameInput, setSheetNameInput] = useState('');
  const [resizing, setResizing] = useState(null);
  const inputRef = useRef(null);
  const cellInputRef = useRef(null);

  const ROWS = 30;
  const COLS = 15;
  const DEFAULT_COL_WIDTH = 120;
  const DEFAULT_ROW_HEIGHT = 32;

  useEffect(() => {
    const token = localStorage.getItem('token');
    const userData = localStorage.getItem('user');
    if (token && userData) {
      setUser(JSON.parse(userData));
      setShowLogin(false);
      loadSheets();
    }
  }, []);

  // WebSocket: listen for remote sheet updates
  useEffect(() => {
    let socket;
    try {
      socket = io('https://easin-google-sheet.onrender.com');
      socket.on('sheets:updated', (data) => {
        const normalized = data.map(s => ({
          id: s.id,
          name: s.name || `Sheet${Math.floor(Math.random()*1000)}`,
          data: s.data || {},
          columnWidths: s.columnWidths || {},
          rowHeights: s.rowHeights || {},
          deps: s.deps || {},
          revDeps: s.revDeps || {},
          computed: s.computed || {}
        }));
        // recompute
        normalized.forEach(ns => recomputeSheet(ns));
        setSheets(normalized);
        if (!activeSheetId && normalized.length > 0) setActiveSheetId(normalized[0].id);
      });
    } catch (e) {
      // socket not available; ignore
    }
    return () => {
      if (socket) socket.disconnect();
    };
  }, [activeSheetId]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Shift') setShiftPressed(true);
    };
    const handleKeyUp = (e) => {
      if (e.key === 'Shift') setShiftPressed(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  const loadSheets = async () => {
    const data = await API.getSheets();
    const normalized = data.map(s => ({
      id: s.id,
      name: s.name || `Sheet${Math.floor(Math.random()*1000)}`,
      data: s.data || {},
      columnWidths: s.columnWidths || {},
      rowHeights: s.rowHeights || {},
      deps: s.deps || {},
      revDeps: s.revDeps || {},
      computed: s.computed || {}
    }));
    // recompute on load
    normalized.forEach(ns => recomputeSheet(ns));
    setSheets(normalized);
    if (normalized.length > 0) setActiveSheetId(normalized[0].id);
  };

  const handleLogin = async () => {
    try {
      const result = await API.login(email, password);
      localStorage.setItem('token', result.token);
      localStorage.setItem('user', JSON.stringify(result.user));
      setUser(result.user);
      setShowLogin(false);
      loadSheets();
    } catch (error) {
      alert(error?.message || 'Login failed');
    }
  };

  const handleRegister = async () => {
    try {
      await API.register(email, password);
      alert('Registration successful! Please login.');
      setShowRegister(false);
      setEmail('');
      setPassword('');
    } catch (error) {
      alert(error?.message || 'Registration failed');
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
    setShowLogin(true);
    setSheets([]);
  };

  const addNewSheet = () => {
    const newSheet = {
      id: Date.now().toString(),
      name: `Sheet${sheets.length + 1}`,
      data: {},
      columnWidths: {},
      rowHeights: {}
    };
    const updated = [...sheets, newSheet];
    setSheets(updated);
    setActiveSheetId(newSheet.id);
    API.saveSheets(updated).catch(() => {});
  };

  const deleteSheet = (sheetId) => {
    if (sheets.length === 1) {
      alert('Cannot delete the last sheet!');
      return;
    }
    const updatedSheets = sheets.filter(s => s.id !== sheetId);
    setSheets(updatedSheets);
    if (activeSheetId === sheetId) {
      setActiveSheetId(updatedSheets[0].id);
    }
    API.saveSheets(updatedSheets).catch(() => {});
  };

  const saveData = async () => {
    await API.saveSheets(sheets);
    alert('Saved successfully!');
  };

  const activeSheet = sheets.find(s => s.id === activeSheetId);

  const handleCellClick = (col, row) => {
    const cellKey = `${getColumnLetter(col)}${row + 1}`;
    
    if (shiftPressed && selectedCells.length > 0) {
      const firstCell = selectedCells[0];
      const [firstCol, firstRow] = parseCellKey(firstCell);
      const [lastCol, lastRow] = [col, row];
      
      const minCol = Math.min(firstCol, lastCol);
      const maxCol = Math.max(firstCol, lastCol);
      const minRow = Math.min(firstRow, lastRow);
      const maxRow = Math.max(firstRow, lastRow);
      
      const newSelection = [];
      for (let r = minRow; r <= maxRow; r++) {
        for (let c = minCol; c <= maxCol; c++) {
          newSelection.push(`${getColumnLetter(c)}${r + 1}`);
        }
      }
      setSelectedCells(newSelection);
    } else {
      setSelectedCells([cellKey]);
    }
    
    const cellValue = activeSheet?.data[cellKey] || '';
    setCellInput(cellValue);
  };

  const handleCellDoubleClick = (col, row) => {
    const cellKey = `${getColumnLetter(col)}${row + 1}`;
    setEditingCell(cellKey);
    const cellValue = activeSheet?.data[cellKey] || '';
    setCellInput(cellValue);
    setTimeout(() => cellInputRef.current?.focus(), 0);
  };

  const parseCellKey = (cellKey) => {
    const match = cellKey.match(/([A-Z]+)([0-9]+)/);
    if (!match) return [0, 0];
    const col = match[1].split('').reduce((acc, char) => acc * 26 + char.charCodeAt(0) - 64, 0) - 1;
    const row = parseInt(match[2]) - 1;
    return [col, row];
  };

  const handleCellChange = (e) => {
    setCellInput(e.target.value);
  };

  // Must be inside component to access `sheets` and `setSheets`
  const updateCellAndRecalculate = (sheetId, cellKey, rawValue) => {
    const updatedSheets = sheets.map(sheet => {
      if (sheet.id !== sheetId) return sheet;
      const newSheet = {
        ...sheet,
        data: { ...sheet.data, [cellKey]: rawValue },
        deps: sheet.deps || {},
        revDeps: sheet.revDeps || {},
        computed: { ...sheet.computed }
      };

      // rebuild dependencies for the changed cell
      buildDependenciesForCell(cellKey, newSheet);

      // recompute sheet (simple approach)
      recomputeSheet(newSheet);
      return newSheet;
    });
    setSheets(updatedSheets);

    // persist change (async, best-effort)
    API.saveSheets(updatedSheets).catch(() => {});
  };

  const handleCellSubmit = () => {
    if (!editingCell || !activeSheet) return;
    updateCellAndRecalculate(activeSheetId, editingCell, cellInput);
    setEditingCell(null);
  };

  const getCellDisplay = (col, row) => {
    if (!activeSheet) return '';
    const cellKey = `${getColumnLetter(col)}${row + 1}`;
    const computed = activeSheet.computed?.[cellKey];
    if (computed !== undefined) return computed;

    const raw = activeSheet.data[cellKey] || '';
    if (raw.toString().startsWith('=')) {
      // fallback: compute on the fly
      const cache = {};
      return evaluateCellRecursive(cellKey, activeSheet, new Set(), cache);
    }
    return raw;
  };

  const getColumnWidth = (col) => {
    if (!activeSheet) return DEFAULT_COL_WIDTH;
    return activeSheet.columnWidths?.[col] || DEFAULT_COL_WIDTH;
  };

  const getRowHeight = (row) => {
    if (!activeSheet) return DEFAULT_ROW_HEIGHT;
    return activeSheet.rowHeights?.[row] || DEFAULT_ROW_HEIGHT;
  };

  const handleResizeStart = (type, index, e) => {
    e.preventDefault();
    setResizing({ type, index, startX: e.clientX, startY: e.clientY });
  };

  useEffect(() => {
    if (!resizing) return;

    const handleMouseMove = (e) => {
      const updatedSheets = sheets.map(sheet => {
        if (sheet.id !== activeSheetId) return sheet;
        
        if (resizing.type === 'column') {
          const diff = e.clientX - resizing.startX;
          const newWidth = Math.max(50, getColumnWidth(resizing.index) + diff);
          return {
            ...sheet,
            columnWidths: { ...sheet.columnWidths, [resizing.index]: newWidth }
          };
        } else {
          const diff = e.clientY - resizing.startY;
          const newHeight = Math.max(20, getRowHeight(resizing.index) + diff);
          return {
            ...sheet,
            rowHeights: { ...sheet.rowHeights, [resizing.index]: newHeight }
          };
        }
      });
      
      setSheets(updatedSheets);
      setResizing({ ...resizing, startX: e.clientX, startY: e.clientY });
    };

    const handleMouseUp = () => {
      setResizing(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [resizing, sheets, activeSheetId]);

  const startEditingSheetName = (sheetId, currentName) => {
    setEditingSheetId(sheetId);
    setSheetNameInput(currentName);
  };

  const saveSheetName = () => {
    if (!sheetNameInput.trim()) return;
    const updatedSheets = sheets.map(sheet => 
      sheet.id === editingSheetId ? { ...sheet, name: sheetNameInput } : sheet
    );
    setSheets(updatedSheets);
    setEditingSheetId(null);
    API.saveSheets(updatedSheets).catch(() => {});
  };

  const handleKeyPress = (e, action) => {
    if (e.key === 'Enter') action();
  };

  if (showLogin) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-xl p-8 w-full max-w-md">
          <div className="flex items-center justify-center mb-6">
            <FileSpreadsheet className="w-12 h-12 text-indigo-600 mr-2" />
            <h1 className="text-3xl font-bold text-gray-800">Easin Sheet</h1>
          </div>
          
          {!showRegister ? (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyPress={(e) => handleKeyPress(e, handleLogin)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  placeholder="admin@123"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyPress={(e) => handleKeyPress(e, handleLogin)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  placeholder="password"
                />
              </div>
              <button
                onClick={handleLogin}
                className="w-full bg-indigo-600 text-white py-2 rounded-lg hover:bg-indigo-700 transition"
              >
                Login
              </button>
              <button
                onClick={() => setShowRegister(true)}
                className="w-full text-indigo-600 hover:text-indigo-800 text-sm"
              >
                Create new account
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyPress={(e) => handleKeyPress(e, handleRegister)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyPress={(e) => handleKeyPress(e, handleRegister)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
              </div>
              <button
                onClick={handleRegister}
                className="w-full bg-indigo-600 text-white py-2 rounded-lg hover:bg-indigo-700 transition"
              >
                Register
              </button>
              <button
                onClick={() => setShowRegister(false)}
                className="w-full text-indigo-600 hover:text-indigo-800 text-sm"
              >
                Back to login
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <FileSpreadsheet className="w-8 h-8 text-indigo-600" />
          <h1 className="text-xl font-semibold text-gray-800">Easin Sheet</h1>
        </div>
        <div className="flex items-center space-x-3">
          <span className="text-sm text-gray-600">{user?.email}</span>
          {user?.isAdmin && (
            <div className="flex items-center space-x-2">
              <button className="flex items-center space-x-1 px-3 py-1.5 bg-green-100 text-green-700 rounded-lg hover:bg-green-200 transition text-sm" type="button">
                <UserPlus className="w-4 h-4" />
                <span>Admin</span>
              </button>
              <button
                onClick={() => {
                  // Change admin password: verify current then set new
                  const current = window.prompt('Enter current admin password:');
                  if (current === null) return; // cancelled
                  const stored = localStorage.getItem('adminPassword') || 'Easin@2@#$';
                  if (current !== stored) {
                    alert('Current password is incorrect.');
                    return;
                  }
                  const next = window.prompt('Enter new password:');
                  if (next === null || next.trim().length === 0) {
                    alert('Password not changed.');
                    return;
                  }
                  localStorage.setItem('adminPassword', next);
                  alert('Admin password changed.');
                }}
                className="px-3 py-1.5 bg-yellow-100 text-yellow-800 rounded-lg hover:bg-yellow-200 text-sm"
                type="button"
              >
                Change Password
              </button>
            </div>
          )}
          <button
            onClick={saveData}
            className="flex items-center space-x-1 px-3 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition text-sm"
          >
            <Save className="w-4 h-4" />
            <span>Save</span>
          </button>
          <button
            onClick={handleLogout}
            className="flex items-center space-x-1 px-3 py-1.5 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 transition text-sm"
          >
            <LogOut className="w-4 h-4" />
            <span>Logout</span>
          </button>
        </div>
      </div>

      {/* Formula Bar */}
      <div className="bg-white border-b border-gray-200 px-4 py-2 flex items-center space-x-3">
        <span className="text-sm font-medium text-gray-700 w-20">
          {selectedCells.length > 0 ? selectedCells[0] : 'A1'}
        </span>
        <input
          ref={inputRef}
          type="text"
          value={cellInput}
          onChange={handleCellChange}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && selectedCells.length > 0) {
              if ((e.ctrlKey || e.metaKey) && selectedCells.length > 1) {
                // fill all selected cells (Ctrl+Enter)
                const updatedSheets = sheets.map(sheet => {
                  if (sheet.id !== activeSheetId) return sheet;
                  const newData = { ...sheet.data };
                  selectedCells.forEach(k => newData[k] = cellInput);
                  const newSheet = { ...sheet, data: newData };
                  // rebuild deps for changed cells
                  selectedCells.forEach(k => buildDependenciesForCell(k, newSheet));
                  recomputeSheet(newSheet);
                  return newSheet;
                });
                setSheets(updatedSheets);
                API.saveSheets(updatedSheets).catch(() => {});
              } else {
                updateCellAndRecalculate(activeSheetId, selectedCells[0], cellInput);
              }
            }
          }}
          className="flex-1 px-3 py-1.5 border border-gray-300 rounded focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm"
          placeholder="Enter value or formula (e.g., =A1+B1)"
        />
        {selectedCells.length > 1 && (
          <span className="text-sm text-gray-500">{selectedCells.length} cells selected</span>
        )}
      </div>

      {/* Spreadsheet Grid */}
      <div className="flex-1 overflow-auto p-4">
        <div className="inline-block bg-white border border-gray-300 rounded-lg shadow-sm">
          <table className="border-collapse">
            <thead>
              <tr>
                <th className="sticky left-0 top-0 bg-gray-100 border border-gray-300 w-12 h-8 text-xs font-semibold text-gray-600 z-20"></th>
                {Array.from({ length: COLS }).map((_, i) => (
                  <th 
                    key={i} 
                    className="relative bg-gray-100 border border-gray-300 h-8 text-xs font-semibold text-gray-600 sticky top-0 z-10"
                    style={{ width: `${getColumnWidth(i)}px` }}
                  >
                    {getColumnLetter(i)}
                    <div
                      className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-indigo-400"
                      onMouseDown={(e) => handleResizeStart('column', i, e)}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: ROWS }).map((_, row) => (
                <tr key={row}>
                  <td 
                    className="relative sticky left-0 bg-gray-100 border border-gray-300 text-center text-xs font-semibold text-gray-600 z-10"
                    style={{ height: `${getRowHeight(row)}px` }}
                  >
                    {row + 1}
                    <div
                      className="absolute left-0 right-0 bottom-0 h-1 cursor-row-resize hover:bg-indigo-400"
                      onMouseDown={(e) => handleResizeStart('row', row, e)}
                    />
                  </td>
                  {Array.from({ length: COLS }).map((_, col) => {
                    const cellKey = `${getColumnLetter(col)}${row + 1}`;
                    const isSelected = selectedCells.includes(cellKey);
                    const isEditing = editingCell === cellKey;
                    
                    return (
                      <td
                        key={col}
                        onClick={() => handleCellClick(col, row)}
                        onDoubleClick={() => handleCellDoubleClick(col, row)}
                        className={`border border-gray-300 px-2 text-sm cursor-cell relative ${
                          isSelected ? 'ring-2 ring-indigo-500 bg-blue-50' : 'hover:bg-blue-50'
                        }`}
                        style={{ 
                          width: `${getColumnWidth(col)}px`,
                          height: `${getRowHeight(row)}px`
                        }}
                      >
                        {isEditing ? (
                          <input
                            ref={cellInputRef}
                            type="text"
                            value={cellInput}
                            onChange={handleCellChange}
                            onKeyDown={(e) => e.key === 'Enter' && handleCellSubmit()}
                            onBlur={handleCellSubmit}
                            className="w-full h-full px-1 border-none outline-none bg-white"
                          />
                        ) : (
                          <div className="truncate">{getCellDisplay(col, row)}</div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Sheet Tabs */}
      <div className="bg-white border-t border-gray-200 px-4 py-2 flex items-center space-x-2 overflow-x-auto">
        <button
          onClick={() => setShowSheetList(!showSheetList)}
          className="p-1.5 hover:bg-gray-100 rounded"
        >
          <Menu className="w-5 h-5 text-gray-600" />
        </button>
        
        {showSheetList && (
          <div className="absolute bottom-16 left-4 bg-white border border-gray-300 rounded-lg shadow-lg p-2 w-64 z-30">
            <div className="flex items-center justify-between mb-2 pb-2 border-b">
              <span className="font-semibold text-sm">All Sheets</span>
              <button onClick={() => setShowSheetList(false)}>
                <X className="w-4 h-4" />
              </button>
            </div>
            {sheets.map(sheet => (
              <div key={sheet.id} className="flex items-center justify-between p-2 hover:bg-gray-50 rounded">
                <button
                  onClick={() => {
                    setActiveSheetId(sheet.id);
                    setShowSheetList(false);
                  }}
                  className="flex-1 text-left text-sm"
                >
                  {sheet.name}
                </button>
                <button
                  onClick={() => deleteSheet(sheet.id)}
                  className="text-red-500 hover:text-red-700 text-xs ml-2"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
        
        {sheets.map(sheet => (
          <div key={sheet.id} className="flex items-center space-x-1">
            {editingSheetId === sheet.id ? (
              <div className="flex items-center space-x-1">
                <input
                  type="text"
                  value={sheetNameInput}
                  onChange={(e) => setSheetNameInput(e.target.value)}
                  onKeyPress={(e) => handleKeyPress(e, saveSheetName)}
                  onBlur={saveSheetName}
                  className="px-2 py-1 text-sm border border-indigo-500 rounded"
                  autoFocus
                />
                <button onClick={saveSheetName}>
                  <Check className="w-4 h-4 text-green-600" />
                </button>
              </div>
            ) : (
              <div
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { setActiveSheetId(sheet.id); } }}
                onClick={() => setActiveSheetId(sheet.id)}
                className={`px-4 py-1.5 rounded-t-lg text-sm font-medium transition flex items-center space-x-2 ${
                  activeSheetId === sheet.id
                    ? 'bg-indigo-100 text-indigo-700 border-b-2 border-indigo-600'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                <span>{sheet.name}</span>
                {activeSheetId === sheet.id && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      startEditingSheetName(sheet.id, sheet.name);
                    }}
                    className="hover:bg-indigo-200 p-0.5 rounded"
                    type="button"
                  >
                    <Edit2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
        <button
          onClick={addNewSheet}
          className="flex items-center space-x-1 px-3 py-1.5 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 transition text-sm"
        >
          <Plus className="w-4 h-4" />
          <span>Add Sheet</span>
        </button>
      </div>
    </div>
  );
}

export default App;