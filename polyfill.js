

(function(global) {
  var connections = {};

  // to avoid collisions like '__proto__'
  var protectName = function(name) {
    return '$' + name;
  };
  var unprotectName = function(protected_name) {
    return protected_name.substring(1);
  };

  var keyInRange = function(range, key, keyOpen) {
    var lowerOpen = keyOpen || range.lowerOpen;
    var upperOpen = keyOpen || range.upperOpen;
    return ((lowerOpen && indexedDB.cmp(key, range.lower) > 0) ||
            (!lowerOpen && indexedDB.cmp(key, range.lower) >= 0)) &&
           ((upperOpen && indexedDB.cmp(key, range.upper) < 0) ||
            (!lowerOpen && indexedDB.cmp(key, range.upper) <= 0))
  };
  var rangesIntersect = function(range1, range2) {
    var lower1Open = range1.lowerOpen || range2.upperOpen;
    var upper1Open = range1.upperOpen || range2.lowerOpen;
    return ((lower1Open && indexedDB.cmp(range1.lower, range2.upper) < 0) ||
            (!lower1Open && indexedDB.cmp(range1.lower, range2.upper) <= 0)) &&
           ((upper1Open && indexedDB.cmp(range1.upper, range2.lower) > 0) ||
            (!upper1Open && indexedDB.cmp(range1.upper, range2.lower) >= 0));
  }

  var filterForRange = function(range) {
    return function(element) {
      if (element.type == "clear") {
        return true;
      }
      if (element.key instanceof IDBKeyRange) {
        return rangesIntersect(element.key, range);
      } else {
        return keyInRange(range, element.key, false);
      }
    };
  }

  // name assumed to be protected
  var addOpenDatabase = function(db, name){
    db._listeners = {};
    db._openTransactions = 0;
    db._closePending = false;
    connections[name] = connections[name] || [];
    connections[name].push(db);
  };
  var closeDatabase = function(db) {
    for (var osName in db._listeners) {
      var list = db._listeners[osName];
      for (var i = 0; i < list.length; i++) {
        list[i].alive = false;
      }
    }
    db._listeners = {};
    var list = connections[protectName(db.name)];
    if (!list) {
      console.log('Cannot find db connection for name ' + db.name);
      return;
    }
    var index = list.indexOf(db);
    list.splice(index, 1);
  };

  // os store names assumed to be unprotected,
  // returns control object
  var addObserver = function(db, objectStoresAndRanges, fcn, options) {
    var osToRange = {};
    for (var i = 0; i < objectStoresAndRanges.length; i++) {
      var nameAndRange = objectStoresAndRanges[i];
      osToRange[protectName(nameAndRange.name)] = nameAndRange.range;
    }
    var listener = { db: db, fcn: fcn, ranges: osToRange, alive: true, options: options };

    var osNames = [];
    for (var i = 0; i < objectStoresAndRanges.length; i++) {
      var nameAndRange = objectStoresAndRanges[i];
      osNames.push(nameAndRange.name);
      var name = protectName(nameAndRange.name);
      db._listeners[name] = db._listeners[name] || [];
      db._listeners[name].push(listener);
    }
    // let the observer load initial state.
    var txn = db.transaction(osNames, 'readonly');
    fcn(null, { db: db, objectStoreName: null, isExternalChange: false, transaction: txn});
    var control = {
      isAlive: function() {
        return listener.alive;
      },
      stop: function() {
        for (var osName in listener.ranges) {
          var list = db._listeners[osName];
          if (!list) {
            console.log('could not find list for object store ' + osName);
            continue;
          }
          var index = list.indexOf(listener);
          if (index === -1) {
            console.log('could not find listener in list for object store ' + osName);
            return;
          }
          list.splice(index, 1);
        }
        listener.alive = false;
      }
    };
    return control;
  };

  // protected name
  var hasListeners = function(dbname, osName) { 
    var dbs = connections[dbname];
    if (!dbs) {
      return false;
    }
    for (var i = 0; i < dbs.length; i++) {
      var listeners = dbs[i]._listeners;
      if (listeners && listeners[osName] && listeners[osName].length > 0) {
        return true;
      }
    }
    return false;
  };
  // protected name
  var hasListenersForValues = function(dbname, osName) {
    var dbs = connections[dbname];
    if (!dbs) {
      return false;
    }
    for (var i = 0; i < dbs.length; i++) {
      var listeners = dbs[i]._listeners;
      if (listeners && listeners[osName]) {
        var list = listeners[osName];
        for (var i = 0; i < list.length; i++) {
          if (list[i].options.includeValues) {
            return true;
          }
        }
      }
    }
    return false;
  };
  
  var pushOperation = function(objectStore, changesMap, type, keyOrRange, value) { 
    var name = protectName(objectStore.name);
    if (!hasListeners(objectStore.transaction.db.name, name)) {
      return;
    }
    if (!changesMap[name]) {
      changesMap[name] = { changes: [], valueChanges: [] };
    }
    var operation = { type: type };
    if (keyOrRange) {
      operation.key = keyOrRange;
    }
    if (hasListenersForValues(objectStore.transaction.db.name, name)) {
      var valueOperation = { type: type };
      if (keyOrRange) {
        valueOperation.key = keyOrRange;
      }
      if (value) {
        valueOperation.value = value;
      }
      changesMap[name].valueChanges.push(valueOperation);
    }
    changesMap[name].changes.push(operation);
  };

  var getListeners = function(dbName, objectStoreName) {
    if (!connections[dbName]) {
      return [];
    }
    var listeners = [];
    connections[dbName].forEach(function(db) {
      if (!db._listeners[objectStoreName]) {
        return;
      }
      listeners = listeners.concat(db._listeners[objectStoreName]);
    });
    return listeners;
  };

  var $open = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function(name /*, version*/) {
    var request = $open.apply(this, arguments);
    request.addEventListener('success', function() {
      var connection = request.result;
      addOpenDatabase(connection, name);
    });
    return request;
  };

  var $close = IDBDatabase.prototype.close;
  IDBDatabase.prototype.close = function() {
    $close.apply(this, arguments);
    if (this._openTransactions === 0) {
      closeDatabase(this);
    } else {
      this._closePending = true;
    }
  };

  IDBDatabase.prototype.observe = function(namesOrNamesAndRanges, listenerFunction, options) {
    var sanitizedNamesAndRanges = [];
    if (typeof namesOrNamesAndRanges === 'string') {
      sanitizedNamesAndRanges = [{ name: namesOrNamesAndRanges }];
    } else if (typeof namesOrNamesAndRanges === 'object') {
      if (Array.isArray(namesOrNamesAndRanges)) {
        for (var i = 0; i < namesOrNamesAndRanges.length; i++) {
          var argEntry = namesOrNamesAndRanges[i];
          if (typeof argEntry === "string") {
            argEntry = { name: argEntry };
          }
          if (!argEntry.name) {
            console.log('No name provided for namesAndRanges array entry: ', argEntry);
            continue;
          }
          var entry = {
            name: argEntry.name,
            range: argEntry.range
          }
          sanitizedNamesAndRanges.push(entry);
        }
      } else {
        if (!namesOrNamesAndRanges.name) {
          console.log('No name provided for namesAndRanges: ', namesOrNamesAndRanges);
          return null;
        }
        var entry = {
          name: namesOrNamesAndRanges.name,
          range: namesOrNamesAndRanges.range
        };  
        sanitizedNamesAndRanges.push(entry);
      }
    } else {
      console.log('unknown namesOrNamesAndRanges argument: ', namesOrNamesAndRanges);
      return null;
    }
    if (sanitizedNamesAndRanges.length == 0) {
      console.log('could not parse namesOrNamesAndRanges argument');
      return null;
    }
    var sanatizedOptions = {
      includeValues: options ? !!options.includeValues : false,
      includeTransaction: options ? !!options.includeTransaction : false
    }
    return addObserver(this, sanitizedNamesAndRanges, listenerFunction, sanatizedOptions);
  };

  var $transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function(scope, mode) {
    var tx = $transaction.apply(this, arguments);
    if (mode !== 'readwrite') return tx;
    tx._changes = [];
    tx.db._openTransactions += 1;
    tx.addEventListener('complete', function() {
      var changeMap = tx._changes;
      tx._changes = [];
      for (var objectStoreName in changeMap) {
        var unprotectedName = unprotectName(objectStoreName);
        var listeners = getListeners(tx.db.name, objectStoreName);
        var changesRecord = changeMap[objectStoreName];
        for (var i = 0; i < listeners.length; i++) {
          var listener = listeners[i];
          var metadata = {
            db: listener.db,
            objectStoreName: unprotectedName,
            isExternalChange: false
          };
          var changes = changesRecord.changes;
          if (listener.options.includeValues) {
            changes = changesRecord.valueChanges;
          }
          var range = listener.ranges[objectStoreName];
          if (range) {
            changes = changes.filter(filterForRange(range));
          }
          if (changes.length == 0) {
            continue;
          }
          if (listener.options.includeTransaction) {
            var osNames = Object.keys(listener.ranges).map(function(value) {
              return unprotectName(value);
            });
            metadata.transaction = tx.db.transaction(osNames, 'readonly');
          }
          listener.fcn(changes, metadata);
        }
      }
      tx.db._openTransactions -= 1;
      if (tx.db._closePending) {
        closeDatabase(tx.db);
      }
    });
    tx.addEventListener('abort', function() {
      tx.db._openTransactions -= 1;
      if (tx.db._closePending) {
        closeDatabase(tx.db);
      }
    })
    return tx;
  };

  var $put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(value /*, key*/) {
    var $this = this;
    var request = $put.apply(this, arguments);
    request.addEventListener('success', function() {
      var key = request.result;
      pushOperation($this, $this.transaction._changes, 'put', key, value);
    });
    return request;
  };
 
  var $add = IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add = function(value /*, key*/) {
    var $this = this;
    var request = $add.apply(this, arguments);
    request.addEventListener('success', function() {
      var key = request.result;
      pushOperation($this, $this.transaction._changes, 'add', key, value);
    });
    return request;
  };
 
  var $delete = IDBObjectStore.prototype.delete;
  IDBObjectStore.prototype.delete = function(key_or_range) {
    var $this = this;
    var request = $delete.apply(this, arguments);
    request.addEventListener('success', function() {
      pushOperation($this, $this.transaction._changes, 'delete', key_or_range);
    });
    return request;
  };
 
  var $clear = IDBObjectStore.prototype.clear;
  IDBObjectStore.prototype.clear = function() {
    var $this = this;
    var request = $clear.apply(this, arguments);
    request.addEventListener('success', function() {
      pushOperation($this, $this.transaction._changes, 'clear');
    });
    return request;
  };
 
  function effectiveStore(source) {
    return ('objectStore' in source) ? source.objectStore : source;
  }
 
  var $update = IDBCursor.prototype.update;
  IDBCursor.prototype.update = function(value) {
    var $this = this;
    var key = $this.primaryKey;
    var request = $update.apply(this, arguments);
    request.addEventListener('success', function() {
      var store = effectiveStore($this);
      pushOperation(store, store.transaction._changes, 'put', key, value);
    });
    return request;
  };
 
  var $cursorDelete = IDBCursor.prototype.delete;
  IDBCursor.prototype.delete = function() {
    var $this = this;
    var key = $this.primaryKey;
    var request = $cursorDelete.apply(this, arguments);
    request.addEventListener('success', function() {
      var store = effectiveStore($this);
      pushOperation(store, store.transaction._changes, 'delete', key);
    });
    return request;
  };
 
}(this));