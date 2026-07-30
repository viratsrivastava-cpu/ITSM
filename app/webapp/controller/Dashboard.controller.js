sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/ui/model/Sorter",
  "sap/m/MessageToast",
  "itsm/ui/util/UserMenu"
], function (Controller, JSONModel, Filter, FilterOperator, Sorter, MessageToast, UserMenu) {
  "use strict";
 
  // The full pool of KPI tiles a user can choose from — always exactly 7
  // shown at a time (see DEFAULT_TILE_KEYS / onManageTiles). Three flavors:
  //  - "status": code is a STATUS lookup code (null = every ticket)
  //  - "priority": code is a PRIORITY lookup code (P1-P4)
  //  - "metric": code names a value computed in _loadCounts (not a lookup)
  // Colours use NumericContent value states: Good / Critical / Error / Neutral.
  // Each tile also gets a distinct left-border accent (see .tileRow rules in
  // style.css, matched by tile position) so the row reads as 7 different
  // tiles rather than repeated colours.
  var ALL_TILES = [
    { key: "ALL",               label: "Total",             type: "status",   code: null,                color: "Neutral",  icon: "sap-icon://sum" },
    { key: "NEW",               label: "New",               type: "status",   code: "NEW",               color: "Neutral",  icon: "sap-icon://create" },
    { key: "IN_PROCESS",        label: "In Process",        type: "status",   code: "IN_PROCESS",        color: "Critical", icon: "sap-icon://work-history" },
    { key: "CUSTOMER_ACTION",   label: "Customer Action",   type: "status",   code: "CUSTOMER_ACTION",   color: "Error",    icon: "sap-icon://pending" },
    { key: "SOLUTION_PROPOSED", label: "Solution Proposed", type: "status",   code: "SOLUTION_PROPOSED", color: "Neutral",  icon: "sap-icon://lightbulb" },
    { key: "CONFIRMED",         label: "Confirmed",         type: "status",   code: "CONFIRMED",         color: "Good",     icon: "sap-icon://accept" },
    { key: "CLOSED",            label: "Closed",            type: "status",   code: "CLOSED",            color: "Good",     icon: "sap-icon://sys-enter-2" },
    { key: "P1",                label: "P1 Tickets",        type: "priority", code: "P1",                color: "Error",    icon: "sap-icon://flag" },
    { key: "P2",                label: "P2 Tickets",        type: "priority", code: "P2",                color: "Critical", icon: "sap-icon://flag" },
    { key: "P3",                label: "P3 Tickets",        type: "priority", code: "P3",                color: "Neutral",  icon: "sap-icon://flag" },
    { key: "P4",                label: "P4 Tickets",        type: "priority", code: "P4",                color: "Good",     icon: "sap-icon://flag" },
    { key: "BREACHED",          label: "SLA Breached",      type: "metric",   code: "breached",          color: "Error",    icon: "sap-icon://message-error" },
    { key: "AT_RISK",           label: "At Risk",           type: "metric",   code: "atRisk",            color: "Critical", icon: "sap-icon://alert" },
    { key: "UNASSIGNED",        label: "Unassigned",        type: "metric",   code: "unassigned",        color: "Critical", icon: "sap-icon://employee" }
  ];
 
  var DEFAULT_TILE_KEYS = ["ALL", "NEW", "IN_PROCESS", "CUSTOMER_ACTION", "SOLUTION_PROPOSED", "CONFIRMED", "CLOSED"];
  var TILE_COUNT = 7;
  var TILE_PREF_KEY = "itsm.dashboard.tileKeys";
 
  // Same "pick from a pool" idea as the KPI tiles, applied to the table
  // toolbar: exactly FILTER_COUNT filter dropdowns shown out of the full
  // FILTER_POOL, and any number (at least one) of columns shown out of
  // the full COLUMN_POOL. Both persisted in localStorage.
  var FILTER_POOL = [
    { key: "STATUS",   label: "Status" },
    { key: "CATEGORY", label: "Category" },
    { key: "PRIORITY", label: "Priority" },
    { key: "ASSIGNEE", label: "Assignee" },
    { key: "IMPACT",   label: "Impact" },
    { key: "URGENCY",  label: "Urgency" }
  ];
  var DEFAULT_FILTER_KEYS = ["CATEGORY", "PRIORITY", "ASSIGNEE"];
  var FILTER_COUNT = 3;
  var FILTER_PREF_KEY = "itsm.dashboard.filterKeys";
  var FILTER_SELECT_IDS = {
    STATUS: "statusFilter", CATEGORY: "categoryFilter", PRIORITY: "priorityFilter",
    ASSIGNEE: "assigneeFilter", IMPACT: "impactFilter", URGENCY: "urgencyFilter"
  };
 
  var COLUMN_POOL = [
    { key: "TICKET_NUMBER",     label: "Ticket #" },
    { key: "SHORT_DESCRIPTION", label: "Short Description" },
    { key: "STATUS",            label: "Status" },
    { key: "PRIORITY",          label: "Priority" },
    { key: "SLA",                label: "SLA" },
    { key: "CATEGORY",          label: "Category" },
    { key: "IMPACT",             label: "Impact" },
    { key: "URGENCY",            label: "Urgency" },
    { key: "ASSIGNEE",          label: "Assigned To" },
    { key: "CREATED_ON",        label: "Created On" }
  ];
  var DEFAULT_COLUMN_KEYS = ["TICKET_NUMBER", "SHORT_DESCRIPTION", "STATUS", "PRIORITY", "SLA", "CATEGORY", "CREATED_ON"];
  var COLUMN_PREF_KEY = "itsm.dashboard.columnKeys";
  var MIN_COLUMNS = 1;
  // Beyond this many visible columns, the table stops being scannable at
  // typical widths (its columns get squeezed/wrapped) — cap the picker
  // here rather than letting every one of the 10 pool columns show at once.
  var MAX_COLUMNS = 7;
 
  // Category-wise donut: a lighter, standard categorical palette (blue,
  // orange, aqua, yellow) instead of the darker default viz colours.
  var CHART_PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#4a3aa7"];
 
  // SLA response/resolution windows per priority code, in hours. Matches
  // (loosely) the descriptions in the PRIORITY lookup master data —
  // P1 "Immediate", P2 "within 4 hours", P3 "1 business day", P4 "5 days".
  var SLA_HOURS = {
    P1: { response: 1,   resolution: 4 },
    P2: { response: 4,   resolution: 24 },
    P3: { response: 24,  resolution: 72 },
    P4: { response: 120, resolution: 240 }
  };
 
  return Controller.extend("itsm.ui.controller.Dashboard", {
 
    onInit: function () {
      this._aSelectedTileKeys = this._loadTileKeyPref();
      this._aSelectedFilterKeys = this._loadFilterKeyPref();
      this._aSelectedColumnKeys = this._loadColumnKeyPref();
 
      // Local model that drives tiles, chart data and the table title.
      this.getView().setModel(new JSONModel({
        tiles: this._buildTiles(),
        categoryData: [],
        tableTitle: "All Tickets"
      }), "dash");
 
      // Drives visibility of the pool-based filter dropdowns and table
      // columns (see FILTER_POOL / COLUMN_POOL above).
      this.getView().setModel(new JSONModel(this._buildColsVisibility()), "cols");
 
      // Currently active filters. Category lives on the categoryFilter
      // Select itself (its selectedKey) rather than a separate variable,
      // since both the donut and the categoryFilter dropdown drive it.
      this._sStatusCode = null;   // from the selected tile
      this._sActiveTileKey = "ALL";
 
      // Recompute every time we land here so newly created tickets show up.
      this.getOwnerComponent().getRouter()
        .getRoute("dashboard")
        .attachPatternMatched(this._onMatched, this);
 
      // Also load immediately: on the initial (landing) load the route's
      // patternMatched can fire before this handler is attached, so the
      // first paint would otherwise show zeros.
      this._loadCounts();
      this._loadFilterOptions();
 
      // Legend off — with several categories it overflows into its own
      // horizontal scrollbar. Category + count still show on hover via the
      // chart's own tooltip (interaction stays on for that).
      this.byId("categoryChart").setVizProperties({
        plotArea: { colorPalette: CHART_PALETTE },
        legend: { visible: false },
        interaction: { noninteractiveMode: false }
      });
 
      this._syncTileClasses();
    },
 
    /* ---------------------------------------------------------
     * Which 7 tiles to show — persisted in localStorage so the choice
     * survives a reload. Falls back to the original 7 (and repairs a
     * stored list that's grown stale, e.g. from an older tile set).
     * ------------------------------------------------------- */
    _loadTileKeyPref: function () {
      try {
        var sSaved = window.localStorage.getItem(TILE_PREF_KEY);
        var aSaved = sSaved && JSON.parse(sSaved);
        if (Array.isArray(aSaved) && aSaved.length === TILE_COUNT &&
            aSaved.every(function (sKey) { return ALL_TILES.some(function (t) { return t.key === sKey; }); })) {
          return aSaved;
        }
      } catch (e) { /* ignore malformed/blocked storage, fall back below */ }
      return DEFAULT_TILE_KEYS.slice();
    },
 
    _saveTileKeyPref: function (aKeys) {
      try {
        window.localStorage.setItem(TILE_PREF_KEY, JSON.stringify(aKeys));
      } catch (e) { /* storage unavailable — selection just won't persist */ }
    },
 
    /* ---------------------------------------------------------
     * Which filter dropdowns / table columns to show — same
     * pool + localStorage pattern as the KPI tiles above.
     * ------------------------------------------------------- */
    _loadFilterKeyPref: function () {
      try {
        var sSaved = window.localStorage.getItem(FILTER_PREF_KEY);
        var aSaved = sSaved && JSON.parse(sSaved);
        if (Array.isArray(aSaved) && aSaved.length === FILTER_COUNT &&
            aSaved.every(function (sKey) { return FILTER_POOL.some(function (f) { return f.key === sKey; }); })) {
          return aSaved;
        }
      } catch (e) { /* ignore malformed/blocked storage, fall back below */ }
      return DEFAULT_FILTER_KEYS.slice();
    },
 
    _saveFilterKeyPref: function (aKeys) {
      try {
        window.localStorage.setItem(FILTER_PREF_KEY, JSON.stringify(aKeys));
      } catch (e) { /* storage unavailable — selection just won't persist */ }
    },
 
    _loadColumnKeyPref: function () {
      try {
        var sSaved = window.localStorage.getItem(COLUMN_PREF_KEY);
        var aSaved = sSaved && JSON.parse(sSaved);
        if (Array.isArray(aSaved) && aSaved.length >= MIN_COLUMNS && aSaved.length <= MAX_COLUMNS &&
            aSaved.every(function (sKey) { return COLUMN_POOL.some(function (c) { return c.key === sKey; }); })) {
          return aSaved;
        }
      } catch (e) { /* ignore malformed/blocked storage, fall back below */ }
      return DEFAULT_COLUMN_KEYS.slice();
    },
 
    _saveColumnKeyPref: function (aKeys) {
      try {
        window.localStorage.setItem(COLUMN_PREF_KEY, JSON.stringify(aKeys));
      } catch (e) { /* storage unavailable — selection just won't persist */ }
    },
 
    // Builds the {filterVisible, columnVisible} maps the "cols" model
    // holds, from the currently selected filter/column keys.
    _buildColsVisibility: function () {
      var that = this;
      var oFilterVisible = {};
      FILTER_POOL.forEach(function (f) { oFilterVisible[f.key] = that._aSelectedFilterKeys.indexOf(f.key) !== -1; });
      var oColumnVisible = {};
      COLUMN_POOL.forEach(function (c) { oColumnVisible[c.key] = that._aSelectedColumnKeys.indexOf(c.key) !== -1; });
      return { filterVisible: oFilterVisible, columnVisible: oColumnVisible };
    },
 
    // Builds the /tiles array from the currently selected keys, in the
    // pool's canonical order (so the row layout is stable regardless of
    // the order tiles were picked in). Counts start at 0; _loadCounts
    // fills them in.
    _buildTiles: function () {
      var that = this;
      return ALL_TILES
        .filter(function (t) { return that._aSelectedTileKeys.indexOf(t.key) !== -1; })
        .map(function (t) {
          return { key: t.key, label: t.label, type: t.type, code: t.code, color: t.color, icon: t.icon, count: 0, selected: t.key === "ALL" };
        });
    },
 
    /* ---------------------------------------------------------
     * Binding the GenericTile's "class" attribute (plain or expression
     * syntax) silently fails to resolve in this UI5 build, and sap.m.HBox
     * has no updateFinished event to hook either — so the accent
     * (acc1..accN) and selection (kpiSel) classes are applied directly on
     * the real control instances, every time the tiles model changes.
     * ------------------------------------------------------- */
    _syncTileClasses: function () {
      var oHBox = this.byId("tileRow");
      if (!oHBox) { return; }
      oHBox.getItems().forEach(function (oWrap, i) {
        var oTile = oWrap.getItems()[0];   // the GenericTile
        var oBadge = oWrap.getItems()[1];  // the trend-arrow badge Text
        oTile.addStyleClass("acc" + (i + 1));
        var oCtx = oTile.getBindingContext("dash");
        oTile.toggleStyleClass("kpiSel", !!(oCtx && oCtx.getProperty("selected")));
        if (oBadge && oCtx) {
          oBadge.toggleStyleClass("trendUp", oCtx.getProperty("trendDirection") === "Up");
          oBadge.toggleStyleClass("trendDown", oCtx.getProperty("trendDirection") === "Down");
        }
      });
    },
 
    // Same reasoning as _syncTileClasses: the color key beside the donut
    // needs each row's dot painted per-category, and binding a color
    // straight onto a plain control isn't reliable here either — so each
    // row gets an index-based accent class instead, in the same order
    // (and same 6-color palette) the donut itself cycles through.
    _syncCategoryKeyClasses: function () {
      var oBox = this.byId("chartKeyBox");
      if (!oBox) { return; }
      oBox.getItems().forEach(function (oRow, i) {
        oRow.addStyleClass("keyAcc" + ((i % 6) + 1));
      });
    },
 
    _onMatched: function () {
      this._loadCounts();
      // Refresh the table binding too (a ticket may have been created).
      var oBinding = this.byId("dashTable").getBinding("items");
      if (oBinding) { oBinding.refresh(); }
 
      // A category tile on the analytics page stashes its pick here
      // before navigating back, so that data shows up already filtered.
      var oComponent = this.getOwnerComponent();
      if (oComponent._pendingCategoryFilter) {
        this.byId("categoryFilter").setSelectedKey(oComponent._pendingCategoryFilter);
        delete oComponent._pendingCategoryFilter;
        this._applyFilters();
      }
    },
 
    /* ---------------------------------------------------------
     * Pull every incident once (only the fields we need) and compute
     * every tile count (status, priority, and SLA-derived metrics) plus
     * the category breakdown from it. One request instead of one-per-tile.
     * ------------------------------------------------------- */
    _loadCounts: function () {
      var that = this;
      var oModel = this.getOwnerComponent().getModel();
 
      // Read only flat, primitive fields — no nested navigation access
      // (getProperty("status/code") on an expand is not reliable in v4).
      // We map the foreign keys to codes/names via the Lookup entity instead.
      var oStatusB = oModel.bindList("/LookupValues", null, [], [
        new Filter("lookupType", FilterOperator.EQ, "STATUS")
      ], { $select: "ID,code" });
 
      var oPriB = oModel.bindList("/LookupValues", null, [], [
        new Filter("lookupType", FilterOperator.EQ, "PRIORITY")
      ], { $select: "ID,code" });
 
      var oCatB = oModel.bindList("/LookupValues", null, [], [
        new Filter("lookupType", FilterOperator.EQ, "CATEGORY1")
      ], { $select: "ID,name" });
 
      var oIncB = oModel.bindList("/Tickets", null, [], [
        new Filter("IsActiveEntity", FilterOperator.EQ, true)
      ], {
        $select: "ID,status_ID,priority_ID,category1_ID,messageProcessor_ID,createdAt,firstResponseAt,completedAt"
      });
 
      Promise.all([
        oStatusB.requestContexts(0, 999),
        oPriB.requestContexts(0, 999),
        oCatB.requestContexts(0, 999),
        oIncB.requestContexts(0, 9999)
      ]).then(function (aRes) {
        // id -> code / name maps
        var mStatusCode = {};
        aRes[0].forEach(function (c) { mStatusCode[c.getProperty("ID")] = c.getProperty("code"); });
        var mPriCode = {};
        aRes[1].forEach(function (c) { mPriCode[c.getProperty("ID")] = c.getProperty("code"); });
        var mCatName = {};
        aRes[2].forEach(function (c) { mCatName[c.getProperty("ID")] = c.getProperty("name"); });
 
        var mStatusCount = {};   // code -> count
        var mPriorityCount = {}; // code -> count
        var mCatCount = {};      // category name -> count
        var iBreached = 0, iAtRisk = 0, iUnassigned = 0;
        var aInc = aRes[3];
        var iTotal = aInc.length;
 
        // "Vs last week" per tile — this-week/last-week counts of tickets
        // matching that tile's own criteria, bucketed purely by createdAt
        // (the only thing we have real history for; no snapshot of past
        // status/priority/SLA states exists to compare against).
        var iNow = Date.now();
        var WEEK_MS = 7 * 86400000;
        function weekBucket(sCreatedAt) {
          if (!sCreatedAt) { return null; }
          var iAge = iNow - new Date(sCreatedAt).getTime();
          if (iAge < WEEK_MS) { return "this"; }
          if (iAge < 2 * WEEK_MS) { return "last"; }
          return null;
        }
        function bump(oMap, sKey, sBucket) {
          if (!sKey || !sBucket) { return; }
          if (!oMap[sKey]) { oMap[sKey] = { thisWeek: 0, lastWeek: 0 }; }
          if (sBucket === "this") { oMap[sKey].thisWeek++; }
          else { oMap[sKey].lastWeek++; }
        }
        var mStatusWeek = {};
        var mPriorityWeek = {};
        var mMetricWeek = {};
 
        aInc.forEach(function (oCtx) {
          var sCreated = oCtx.getProperty("createdAt");
          var sBucket = weekBucket(sCreated);
          bump(mStatusWeek, "ALL", sBucket);
 
          var sStatusId = oCtx.getProperty("status_ID");
          var sStatusCode = sStatusId && mStatusCode[sStatusId];
          if (sStatusCode) {
            mStatusCount[sStatusCode] = (mStatusCount[sStatusCode] || 0) + 1;
            bump(mStatusWeek, sStatusCode, sBucket);
          }
 
          var sCatId = oCtx.getProperty("category1_ID");
          var sName = sCatId && mCatName[sCatId];
          if (sName) { mCatCount[sName] = (mCatCount[sName] || 0) + 1; }
 
          if (!oCtx.getProperty("messageProcessor_ID")) {
            iUnassigned++;
            bump(mMetricWeek, "unassigned", sBucket);
          }
 
          var sPriId = oCtx.getProperty("priority_ID");
          var sPriCode = sPriId && mPriCode[sPriId];
          if (sPriCode) {
            mPriorityCount[sPriCode] = (mPriorityCount[sPriCode] || 0) + 1;
            bump(mPriorityWeek, sPriCode, sBucket);
 
            var sCompleted = oCtx.getProperty("completedAt");
            var oResult = that._computeSla(sPriCode, sCreated, oCtx.getProperty("firstResponseAt"), sCompleted);
            if (oResult.state === "Error") {
              iBreached++;
              bump(mMetricWeek, "breached", sBucket);
            } else if (!sCompleted && oResult.state === "Warning") {
              iAtRisk++;
              bump(mMetricWeek, "atRisk", sBucket);
            }
          }
        });
 
        // Diagnostic — remove once verified. Shows in the browser console.
        // eslint-disable-next-line no-console
        console.log("[Dashboard] incidents:", iTotal, "byStatus:", mStatusCount, "byCategory:", mCatCount);
 
        var mMetric = { breached: iBreached, atRisk: iAtRisk, unassigned: iUnassigned };
 
        var oDash = that.getView().getModel("dash");
 
        // Tiles
        var aTiles = oDash.getProperty("/tiles").map(function (t) {
          var oWeek;
          if (t.type === "status") {
            t.count = (t.code === null) ? iTotal : (mStatusCount[t.code] || 0);
            oWeek = mStatusWeek[t.code === null ? "ALL" : t.code];
          } else if (t.type === "priority") {
            t.count = mPriorityCount[t.code] || 0;
            oWeek = mPriorityWeek[t.code];
          } else {
            t.count = mMetric[t.code] || 0;
            oWeek = mMetricWeek[t.code];
          }
          oWeek = oWeek || { thisWeek: 0, lastWeek: 0 };
          var oTrend = that._formatTrend(oWeek.thisWeek, oWeek.lastWeek);
          t.trendLabel = oTrend.label;
          t.trendDirection = oTrend.direction;
          return t;
        });
        oDash.setProperty("/tiles", aTiles);
        that._syncTileClasses();
 
        // Category chart data — also feeds the ranked list below the donut
        // and the color key beside it, so each row can show its share as a
        // progress bar. Sort order here must match: VizFrame assigns donut
        // slice colors to dimension values in this same array order.
        var iCatTotal = Object.keys(mCatCount).reduce(function (s, k) { return s + mCatCount[k]; }, 0) || 1;
        var aCatData = Object.keys(mCatCount).map(function (sName) {
          var iCount = mCatCount[sName];
          return { name: sName, count: iCount, percent: Math.round((iCount / iCatTotal) * 100) };
        }).sort(function (a, b) { return b.count - a.count; });
        oDash.setProperty("/categoryData", aCatData);
        that._syncCategoryKeyClasses();
      }).catch(function (oErr) {
        // eslint-disable-next-line no-console
        console.error("Dashboard counts failed:", oErr);
      });
    },
 
    /* ---------------------------------------------------------
     * Tile click -> filters the table. What it filters by depends on the
     * tile's type: status tiles filter by status, priority tiles set the
     * priority dropdown, "Unassigned" filters to tickets with nobody
     * assigned. "SLA Breached"/"At Risk" are computed per-ticket against a
     * different window per priority, so there's no single server filter
     * for them — those two just highlight as a stat to look at.
     * ------------------------------------------------------- */
    onTilePress: function (oEvent) {
      var oCtx = oEvent.getSource().getBindingContext("dash");
      if (!oCtx) { return; }
 
      var sKey = oCtx.getProperty("key");
      var sType = oCtx.getProperty("type");
      var sCode = oCtx.getProperty("code");
      var sLabel = oCtx.getProperty("label");
 
      // Highlight the chosen tile, clear the rest.
      this._sActiveTileKey = sKey;
      var oDash = this.getView().getModel("dash");
      var aTiles = oDash.getProperty("/tiles").map(function (t) {
        t.selected = (t.key === sKey);
        return t;
      });
      oDash.setProperty("/tiles", aTiles);
      this._syncTileClasses();
 
      this._sUnassignedOnly = false;
 
      if (sType === "status") {
        this._sStatusCode = sCode;   // null for "Total"
        this.byId("statusFilter").setSelectedKey(sCode || "");
        oDash.setProperty("/tableTitle", sCode ? (sLabel + " Tickets") : "All Tickets");
 
        // "Total" means literally everything — drop every other active
        // filter too (category/priority/assignee/search), not just status.
        if (sKey === "ALL") { this._clearNonStatusFilters(); }
      } else if (sType === "priority") {
        this.byId("priorityFilter").setSelectedKey(sCode);
        oDash.setProperty("/tableTitle", sLabel);
      } else if (sKey === "UNASSIGNED") {
        this._sUnassignedOnly = true;
        oDash.setProperty("/tableTitle", sLabel);
      } else {
        oDash.setProperty("/tableTitle", sLabel);
      }
 
      this._applyFilters();
    },
 
    /* ---------------------------------------------------------
     * Chart segment click -> adds a category filter (combined
     * with whatever status tile is active).
     * ------------------------------------------------------- */
    onChartSelect: function (oEvent) {
      var aData = oEvent.getParameter("data");
      if (aData && aData.length && aData[0].data) {
        this.byId("categoryFilter").setSelectedKey(aData[0].data.Category);
        this._applyFilters();
      }
    },
 
    /* ---------------------------------------------------------
     * Collapse/expand the chart card — slides it shut to the right,
     * handing its width back to the table pane next to it.
     * ------------------------------------------------------- */
    onToggleChart: function () {
      this._bChartCollapsed = !this._bChartCollapsed;
      this.byId("chartPane").toggleStyleClass("chartCollapsed", this._bChartCollapsed);
 
      var oBtn = this.byId("chartToggleBtn");
      oBtn.setIcon(this._bChartCollapsed ? "sap-icon://slim-arrow-left" : "sap-icon://slim-arrow-right");
      oBtn.setTooltip(this._bChartCollapsed ? "Expand chart" : "Collapse chart");
    },
 
    // Category/priority/assignee/search/unassigned all reset together —
    // shared by the "Total" tile (which should mean literally everything)
    // and the header Reset button.
    _clearNonStatusFilters: function () {
      this._sSearch = null;
      this._sUnassignedOnly = false;
 
      var oChart = this.byId("categoryChart");
      if (oChart && oChart.vizSelection) { oChart.vizSelection([]); }
 
      this.byId("categoryFilter").setSelectedKey("");
      this.byId("priorityFilter").setSelectedKey("");
      this.byId("assigneeFilter").setSelectedKey("");
      this.byId("impactFilter").setSelectedKey("");
      this.byId("urgencyFilter").setSelectedKey("");
    },
 
    onResetFilters: function () {
      this._sStatusCode = null;
      this._sActiveTileKey = "ALL";
      this.byId("statusFilter").setSelectedKey("");
 
      var oDash = this.getView().getModel("dash");
      var aTiles = oDash.getProperty("/tiles").map(function (t) {
        t.selected = (t.key === "ALL");
        return t;
      });
      oDash.setProperty("/tiles", aTiles);
      this._syncTileClasses();
      oDash.setProperty("/tableTitle", "All Tickets");
 
      this._clearNonStatusFilters();
      this._applyFilters();
    },
 
    /* ---------------------------------------------------------
     * Priority/Category/Assignee filter dropdowns — same pattern as the
     * ticket list page: options come from the same master data the
     * table's own columns use, plus a leading "All" entry.
     * ------------------------------------------------------- */
    _loadFilterOptions: function () {
      var oModel = this.getOwnerComponent().getModel();
 
      function load(sType, sAllLabel) {
        var oBinding = oModel.bindList("/LookupValues", null, [new Sorter("sequence")], [
          new Filter("lookupType", FilterOperator.EQ, sType)
        ]);
        return oBinding.requestContexts(0, 50).then(function (aCtx) {
          var aItems = aCtx.map(function (c) {
            return { code: c.getProperty("code"), name: c.getProperty("name") };
          });
          aItems.unshift({ code: "", name: sAllLabel });
          return aItems;
        });
      }
 
      // Categories are filtered by name (category1/name), not a code — see
      // _applyFilters and the donut/analytics tiles, which use the same key.
      function loadCategories(sAllLabel) {
        var oBinding = oModel.bindList("/LookupValues", null, [new Sorter("sequence")], [
          new Filter("lookupType", FilterOperator.EQ, "CATEGORY1")
        ]);
        return oBinding.requestContexts(0, 100).then(function (aCtx) {
          var aItems = aCtx.map(function (c) { return { code: c.getProperty("name"), name: c.getProperty("name") }; });
          aItems.unshift({ code: "", name: sAllLabel });
          return aItems;
        });
      }
 
      // Assignees are master.User records (Ticket.messageProcessor), not a
      // separate Agent entity — this schema has no Agent entity at all.
      function loadAssignees(sAllLabel) {
        var oBinding = oModel.bindList("/Users", null, [new Sorter("name")], [
          new Filter("isActive", FilterOperator.EQ, true)
        ]);
        return oBinding.requestContexts(0, 100).then(function (aCtx) {
          var aItems = aCtx.map(function (c) { return { code: c.getProperty("ID"), name: c.getProperty("name") }; });
          aItems.unshift({ code: "", name: sAllLabel });
          return aItems;
        });
      }
 
      var that = this;
      Promise.all([
        load("PRIORITY", "All Priorities"),
        loadCategories("All Categories"),
        loadAssignees("All Assignees"),
        load("STATUS", "All Statuses"),
        load("IMPACT", "All Impacts"),
        load("URGENCY", "All Urgencies")
      ]).then(function (aRes) {
        that.getView().setModel(new JSONModel({
          priorities: aRes[0], categories: aRes[1], assignees: aRes[2],
          statuses: aRes[3], impacts: aRes[4], urgencies: aRes[5]
        }), "filters");
      });
    },
 
    onFilterChange: function (oEvent) {
      // The status filter dropdown drives the same "active status" as a
      // KPI tile click — keep the tile highlighting in sync with it.
      if (oEvent.getSource() === this.byId("statusFilter")) {
        var sCode = oEvent.getSource().getSelectedKey() || null;
        this._sStatusCode = sCode;
        var oDash = this.getView().getModel("dash");
        var aTiles = oDash.getProperty("/tiles").map(function (t) {
          t.selected = (t.type === "status" && t.code === sCode) || (!sCode && t.key === "ALL");
          return t;
        });
        oDash.setProperty("/tiles", aTiles);
        this._syncTileClasses();
      }
      this._applyFilters();
    },
 
    /* ---------------------------------------------------------
     * Combine status + category + priority + assignee + impact + urgency +
     * unassigned + search into one filter set and apply it to the table
     * binding. Each dropdown is only read when its filter is part of the
     * currently selected pool (see FILTER_POOL / onManageTableSettings) —
     * a hidden Select always reports an empty key anyway (cleared on save),
     * so reading them all unconditionally is safe.
     * ------------------------------------------------------- */
    _applyFilters: function () {
      var aFilters = [];
 
      var sStatus = this.byId("statusFilter").getSelectedKey() || this._sStatusCode;
      if (sStatus) {
        aFilters.push(new Filter("status/code", FilterOperator.EQ, sStatus));
      }
      var sCategory = this.byId("categoryFilter").getSelectedKey();
      if (sCategory) { aFilters.push(new Filter("category1/name", FilterOperator.EQ, sCategory)); }
 
      var sPriority = this.byId("priorityFilter").getSelectedKey();
      if (sPriority) { aFilters.push(new Filter("priority/code", FilterOperator.EQ, sPriority)); }
 
      var sAssignee = this.byId("assigneeFilter").getSelectedKey();
      if (sAssignee) { aFilters.push(new Filter("messageProcessor_ID", FilterOperator.EQ, sAssignee)); }
 
      var sImpact = this.byId("impactFilter").getSelectedKey();
      if (sImpact) { aFilters.push(new Filter("impact/code", FilterOperator.EQ, sImpact)); }
 
      var sUrgency = this.byId("urgencyFilter").getSelectedKey();
      if (sUrgency) { aFilters.push(new Filter("urgency/code", FilterOperator.EQ, sUrgency)); }
 
      if (this._sUnassignedOnly) {
        aFilters.push(new Filter("messageProcessor_ID", FilterOperator.EQ, null));
      }
 
      if (this._sSearch) {
        aFilters.push(new Filter({
          filters: [
            new Filter("ticketNumber", FilterOperator.Contains, this._sSearch),
            new Filter("shortDescription", FilterOperator.Contains, this._sSearch)
          ],
          and: false
        }));
      }
 
      this.byId("dashTable").getBinding("items").filter(aFilters);
    },
 
    onSearch: function (oEvent) {
      this._sSearch = (oEvent.getParameter("query") || oEvent.getParameter("newValue") || "").trim();
      this._applyFilters();
    },
 
    /* ---------------------------------------------------------
     * Navigation
     * ------------------------------------------------------- */
    onTicketPress: function (oEvent) {
      var oItem = oEvent.getParameter("listItem") || oEvent.getSource();
      var oCtx = oItem.getBindingContext();
      if (oCtx) {
        this.getOwnerComponent().getRouter().navTo("detail", { id: oCtx.getProperty("ID") });
      }
    },
 
    onCreateTicket: function () {
      this.getOwnerComponent().getRouter().navTo("create");
    },
 
    onGoDashboard: function () {
      this.getOwnerComponent().getRouter().navTo("dashboard");
    },
 
    onGoAnalytics: function () {
      this.getOwnerComponent().getRouter().navTo("analytics");
    },

    onGoServiceGroup: function () {
      this.getOwnerComponent().getRouter().navTo("serviceGroup");
    },

    onProfilePress: function (oEvent) {
      UserMenu.open(oEvent.getSource(), this.getOwnerComponent());
    },
 
    /* ---------------------------------------------------------
     * "Manage Tiles" — pick exactly TILE_COUNT tiles out of the full
     * ALL_TILES pool. Opens with the current selection pre-checked;
     * Save only enables once exactly 7 are checked.
     * ------------------------------------------------------- */
    onManageTiles: function () {
      var aSelectedKeys = this._aSelectedTileKeys;
      var aAllTiles = ALL_TILES.map(function (t) {
        return { key: t.key, label: t.label, selected: aSelectedKeys.indexOf(t.key) !== -1 };
      });
 
      this.getView().setModel(new JSONModel({
        allTiles: aAllTiles,
        selectedCount: aSelectedKeys.length,
        tileCount: TILE_COUNT,
        canSave: aSelectedKeys.length === TILE_COUNT
      }), "tp");
 
      this.byId("tilePickerDialog").open();
    },
 
    onTilePickerSelectionChange: function () {
      var oList = this.byId("tilePickerList");
      var oTp = this.getView().getModel("tp");
      var aAllTiles = oTp.getProperty("/allTiles");
      var iSelectedCount = 0;
 
      oList.getItems().forEach(function (oItem, i) {
        aAllTiles[i].selected = oItem.getSelected();
        if (aAllTiles[i].selected) { iSelectedCount++; }
      });
 
      oTp.setProperty("/allTiles", aAllTiles);
      oTp.setProperty("/selectedCount", iSelectedCount);
      oTp.setProperty("/canSave", iSelectedCount === TILE_COUNT);
    },
 
    onSaveTileSelection: function () {
      var aAllTiles = this.getView().getModel("tp").getProperty("/allTiles");
      var aSelectedKeys = aAllTiles.filter(function (t) { return t.selected; }).map(function (t) { return t.key; });
 
      this._aSelectedTileKeys = aSelectedKeys;
      this._saveTileKeyPref(aSelectedKeys);
 
      this.byId("tilePickerDialog").close();
 
      this.getView().getModel("dash").setProperty("/tiles", this._buildTiles());
      this._loadCounts();
    },
 
    onCancelTileSelection: function () {
      this.byId("tilePickerDialog").close();
    },
 
    /* ---------------------------------------------------------
     * "Table Settings" — pick exactly FILTER_COUNT filters out of
     * FILTER_POOL, and any number (>= MIN_COLUMNS) of columns out of
     * COLUMN_POOL. Same pattern as onManageTiles above.
     * ------------------------------------------------------- */
    onManageTableSettings: function () {
      var aSelectedFilterKeys = this._aSelectedFilterKeys;
      var aAllFilters = FILTER_POOL.map(function (f) {
        return { key: f.key, label: f.label, selected: aSelectedFilterKeys.indexOf(f.key) !== -1 };
      });
 
      var aSelectedColumnKeys = this._aSelectedColumnKeys;
      var aAllColumns = COLUMN_POOL.map(function (c) {
        return { key: c.key, label: c.label, selected: aSelectedColumnKeys.indexOf(c.key) !== -1 };
      });
 
      this.getView().setModel(new JSONModel({
        allFilters: aAllFilters,
        selectedFilterCount: aSelectedFilterKeys.length,
        filterCount: FILTER_COUNT,
        allColumns: aAllColumns,
        selectedColumnCount: aSelectedColumnKeys.length,
        maxColumns: MAX_COLUMNS,
        canSave: aSelectedFilterKeys.length === FILTER_COUNT &&
          aSelectedColumnKeys.length >= MIN_COLUMNS && aSelectedColumnKeys.length <= MAX_COLUMNS
      }), "ts");
 
      this.byId("tableSettingsDialog").open();
    },
 
    onFilterPickerSelectionChange: function () {
      var oList = this.byId("filterPickerList");
      var oTs = this.getView().getModel("ts");
      var aAllFilters = oTs.getProperty("/allFilters");
      var iSelectedCount = 0;
 
      oList.getItems().forEach(function (oItem, i) {
        aAllFilters[i].selected = oItem.getSelected();
        if (aAllFilters[i].selected) { iSelectedCount++; }
      });
 
      oTs.setProperty("/allFilters", aAllFilters);
      oTs.setProperty("/selectedFilterCount", iSelectedCount);
      oTs.setProperty("/canSave", iSelectedCount === FILTER_COUNT && oTs.getProperty("/selectedColumnCount") >= MIN_COLUMNS);
    },
 
    onColumnPickerSelectionChange: function (oEvent) {
      var oList = this.byId("columnPickerList");
      var oTs = this.getView().getModel("ts");
      var aAllColumns = oTs.getProperty("/allColumns");
      var iSelectedCount = 0;
 
      oList.getItems().forEach(function (oItem, i) {
        aAllColumns[i].selected = oItem.getSelected();
        if (aAllColumns[i].selected) { iSelectedCount++; }
      });
 
      // Cap at MAX_COLUMNS — beyond that the table gets squeezed/wraps
      // rather than staying readable. Just-checked item bounces back off.
      if (iSelectedCount > MAX_COLUMNS) {
        var oChangedItem = oEvent.getParameter("listItem");
        var iChangedIndex = oList.indexOfItem(oChangedItem);
        oChangedItem.setSelected(false);
        aAllColumns[iChangedIndex].selected = false;
        iSelectedCount--;
        MessageToast.show("You can show at most " + MAX_COLUMNS + " columns at once.");
      }
 
      oTs.setProperty("/allColumns", aAllColumns);
      oTs.setProperty("/selectedColumnCount", iSelectedCount);
      oTs.setProperty("/canSave", oTs.getProperty("/selectedFilterCount") === FILTER_COUNT &&
        iSelectedCount >= MIN_COLUMNS && iSelectedCount <= MAX_COLUMNS);
    },
 
    onSaveTableSettings: function () {
      var oTs = this.getView().getModel("ts");
      var aAllFilters = oTs.getProperty("/allFilters");
      var aAllColumns = oTs.getProperty("/allColumns");
 
      this._aSelectedFilterKeys = aAllFilters.filter(function (f) { return f.selected; }).map(function (f) { return f.key; });
      this._aSelectedColumnKeys = aAllColumns.filter(function (c) { return c.selected; }).map(function (c) { return c.key; });
 
      this._saveFilterKeyPref(this._aSelectedFilterKeys);
      this._saveColumnKeyPref(this._aSelectedColumnKeys);
 
      this.byId("tableSettingsDialog").close();
 
      this.getView().getModel("cols").setData(this._buildColsVisibility());
 
      // Clear the value of any filter that just got hidden, so it can't
      // keep silently narrowing the table while its dropdown is gone.
      var that = this;
      // Hiding a filter only clears its own dropdown value — status
      // filtering driven by a KPI tile click (this._sStatusCode) is a
      // separate mechanism (see onTilePress/_applyFilters) and stays
      // active even when the Status dropdown itself isn't in the pool.
      FILTER_POOL.forEach(function (f) {
        if (f.key !== "STATUS" && that._aSelectedFilterKeys.indexOf(f.key) === -1) {
          var oSelect = that.byId(FILTER_SELECT_IDS[f.key]);
          if (oSelect) { oSelect.setSelectedKey(""); }
        }
      });
      if (this._aSelectedFilterKeys.indexOf("STATUS") === -1) {
        this.byId("statusFilter").setSelectedKey(this._sStatusCode || "");
      }
      this._applyFilters();
    },
 
    onCancelTableSettings: function () {
      this.byId("tableSettingsDialog").close();
    },
 
    // OData v4 delivers timestamps as ISO strings; format them for display.
    formatDateTime: function (sValue) {
      if (!sValue) { return ""; }
      var oDate = new Date(sValue);
      return isNaN(oDate.getTime()) ? "" : oDate.toLocaleString();
    },
 
    // Status -> sap.ui.core.ValueState, so open/blocked tickets stand out
    // (Customer Action in red) and closed ones read as done (green).
    formatStatusState: function (sName) {
      switch (sName) {
        case "New": return "Information";
        case "In Process": return "Warning";
        case "Customer Action": return "Error";
        case "Solution Proposed": return "Warning";
        case "Confirmed": return "Success";
        case "Closed": return "Success";
        default: return "None";
      }
    },
 
    // Priority -> sap.ui.core.ValueState, so P1/P2 (needs urgent attention)
    // pop in red/amber against the rest of the row.
    formatPriorityState: function (sName) {
      if (!sName) { return "None"; }
      if (sName.indexOf("P1") === 0) { return "Error"; }
      if (sName.indexOf("P2") === 0) { return "Warning"; }
      if (sName.indexOf("P3") === 0) { return "Information"; }
      return "None";
    },
 
    /* ---------------------------------------------------------
     * SLA badge — response clock runs from createdAt until
     * firstResponseAt is stamped (ticket leaves New); resolution
     * clock runs from createdAt until completedAt is stamped
     * (Confirmed/Closed). Both stamped server-side, see service.js.
     * ------------------------------------------------------- */
    formatSlaState: function (sPriorityCode, sCreatedAt, sFirstResponseAt, sCompletedAt) {
      return this._computeSla(sPriorityCode, sCreatedAt, sFirstResponseAt, sCompletedAt).state;
    },
 
    formatSlaText: function (sPriorityCode, sCreatedAt, sFirstResponseAt, sCompletedAt) {
      return this._computeSla(sPriorityCode, sCreatedAt, sFirstResponseAt, sCompletedAt).text;
    },
 
    // A small custom badge (plain Unicode arrows, not the SAP icon font —
    // no glyph-name guessing, and full control over size/weight/color)
    // instead of GenericTile's own footer/indicator, which either don't
    // render in this compact frame type or don't look right. "This week"
    // with nothing to compare against (no tickets 7-14 days ago matching
    // this tile) reads as "+N new" rather than a divide-by-zero percentage.
    // No "N new this week" number here on purpose — with no matching
    // tickets from last week, that count is always identical to the
    // tile's own number, which just reads as a confusing repeat of it.
    _formatTrend: function (iThisWeek, iLastWeek) {
      if (iLastWeek === 0) {
        return iThisWeek > 0
          ? { direction: "Up", label: "▲ all new" }
          : { direction: "None", label: "" };
      }
      var iPct = Math.round((iThisWeek - iLastWeek) / iLastWeek * 100);
      if (iPct === 0) { return { direction: "None", label: "No change from last week" }; }
      return {
        direction: iPct > 0 ? "Up" : "Down",
        label: (iPct > 0 ? "▲ " : "▼ ") + Math.abs(iPct) + "% from last week"
      };
    },
 
    _computeSla: function (sPriorityCode, sCreatedAt, sFirstResponseAt, sCompletedAt) {
      var oWindow = SLA_HOURS[sPriorityCode];
      if (!oWindow || !sCreatedAt) { return { state: "None", text: "-" }; }
 
      var HOUR = 3600000;
      var iCreated = new Date(sCreatedAt).getTime();
      var iNow = Date.now();
 
      if (sCompletedAt) {
        var iResolveBy = iCreated + oWindow.resolution * HOUR;
        return new Date(sCompletedAt).getTime() <= iResolveBy
          ? { state: "Success", text: "SLA Met" }
          : { state: "Error", text: "SLA Breached" };
      }
 
      if (!sFirstResponseAt) {
        var iResponseBy = iCreated + oWindow.response * HOUR;
        var iLeft = iResponseBy - iNow;
        if (iLeft < 0) { return { state: "Error", text: "Response Overdue" }; }
        if (iLeft < oWindow.response * HOUR * 0.25) { return { state: "Warning", text: "Response Due Soon" }; }
        return { state: "Success", text: "On Track" };
      }
 
      var iResolveBy2 = iCreated + oWindow.resolution * HOUR;
      var iLeft2 = iResolveBy2 - iNow;
      if (iLeft2 < 0) { return { state: "Error", text: "Resolution Overdue" }; }
      if (iLeft2 < oWindow.resolution * HOUR * 0.25) { return { state: "Warning", text: "Due Soon" }; }
      return { state: "Success", text: "On Track" };
    }
 
  });
});
 