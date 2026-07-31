sap.ui.define([], function () {
  "use strict";

  /* =========================================================
     CODE -> NAME RESOLUTION

     Before the Ticket/IncidentForm split, status, priority,
     impact and urgency were associations, so the UI could read
     the display text straight off the expand
     ($expand=status($select=name), bound as {status/name}).

     They are plain code columns now. There is nothing to expand,
     so the names have to come from the LookupValue master data
     instead. This module loads that table once and answers
     code -> name from memory, which keeps every list and form
     showing exactly the text it showed before.

     Loaded by Component.js before the router starts, so the maps
     are populated before the first binding is evaluated and no
     control ever renders a raw code and then flips to a name.
     ========================================================= */

  var _mByType = {};        // { STATUS: { NEW: "New", ... }, ... }
  var _pLoaded = null;

  return {

    /**
     * Fetch every LookupValue once. Repeat calls return the same
     * promise, so several controllers can await it without causing
     * several requests.
     */
    load: function (oModel) {
      if (_pLoaded) { return _pLoaded; }

      var oBinding = oModel.bindList("/LookupValues", null, [], [], {
        $select: "ID,lookupType,code,name"
      });

      _pLoaded = oBinding.requestContexts(0, 5000).then(function (aContexts) {
        _mByType = {};
        aContexts.forEach(function (oCtx) {
          var sType = oCtx.getProperty("lookupType");
          if (!_mByType[sType]) { _mByType[sType] = {}; }
          _mByType[sType][oCtx.getProperty("code")] = oCtx.getProperty("name");
        });
        return _mByType;
      }).catch(function () {
        // Never block the app on master data: codes are still readable,
        // just less friendly than the names.
        _mByType = {};
        return _mByType;
      });

      return _pLoaded;
    },

    /**
     * Display text for a code. Falls back to the code itself, so a
     * value that is missing from master data still renders as
     * something meaningful rather than blank.
     */
    name: function (sType, sCode) {
      if (!sCode) { return ""; }
      var mCodes = _mByType[sType];
      return (mCodes && mCodes[sCode]) || sCode;
    },

    /** All {code, name} pairs of a type, for filter dropdowns. */
    items: function (sType) {
      var mCodes = _mByType[sType] || {};
      return Object.keys(mCodes).map(function (sCode) {
        return { code: sCode, name: mCodes[sCode] };
      });
    }
  };
});
