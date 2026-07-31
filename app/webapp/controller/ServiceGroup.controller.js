sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/ui/model/Sorter",
  "sap/m/MessageToast",
  "sap/m/MessageBox",
  "sap/m/ViewSettingsDialog",
  "sap/m/ViewSettingsItem"
], function (Controller, JSONModel, Filter, FilterOperator, Sorter,
             MessageToast, MessageBox, ViewSettingsDialog, ViewSettingsItem) {
  "use strict";

  /* =========================================================
   * SERVICE GROUP DASHBOARD
   *
   * The Service Group routes work: every incident lands with them,
   * they review it and hand it to an assignment group. So the
   * metrics here are about ROUTING (how much is waiting, how fast
   * it gets handed on, how the groups are loaded), not about
   * resolution — that belongs to the groups themselves.
   *
   * Everything is computed from ONE fetch of every incident held in
   * memory and filtered client-side. Two reasons:
   *  - six KPIs, three charts and five widgets all have to agree on
   *    one filtered set; deriving them from separate server queries
   *    is how they drift apart.
   *  - SLA state and age are computed per incident against a window
   *    that varies by priority, so filtering by them (a requirement)
   *    cannot be expressed as an OData filter anyway.
   * ======================================================= */

  // SLA response/resolution windows per priority code, in hours — the same
  // table the Dashboard and Analytics controllers use, so an incident's SLA
  // verdict reads identically wherever it appears.
  var SLA_HOURS = {
    P1: { response: 1,   resolution: 4 },
    P2: { response: 4,   resolution: 24 },
    P3: { response: 24,  resolution: 72 },
    P4: { response: 120, resolution: 240 }
  };

  var CLOSED_STATUS_CODES = ["CONFIRMED", "CLOSED"];
  var IN_PROGRESS_STATUS_CODE = "IN_PROCESS";

  /* ---------------------------------------------------------
   * Row 1 — six compact KPIs, all about routing.
   *
   * `test` tiles are counts and double as filters: pressing one
   * narrows the whole dashboard, pressing it again clears it.
   * `compute` tiles are derived figures (a duration), so they are
   * displayed but not pressable — there is nothing coherent to
   * filter an average by.
   * ------------------------------------------------------- */
  var TILES = [
    {
      key: "RECEIVED", label: "Received", icon: "sap-icon://inbox", color: "Neutral",
      tooltip: "All incidents received, in the current selection",
      test: function () { return true; }
    },
    {
      key: "UNASSIGNED", label: "Unassigned", icon: "sap-icon://request", color: "Error",
      tooltip: "Open incidents not yet routed to an assignment group — the Service Group's own queue",
      test: function (r) { return r.isOpen && !r.teamId; }
    },
    {
      key: "ASSIGNED_TODAY", label: "Assigned Today", icon: "sap-icon://accept", color: "Good",
      tooltip: "Incidents routed to an assignment group today",
      test: function (r) { return r.assignedToday; }
    },
    {
      key: "PENDING", label: "Pending Assignment", icon: "sap-icon://pending", color: "Critical",
      tooltip: "Routed to a group but no engineer has picked them up yet",
      test: function (r) { return r.isOpen && !!r.teamId && !r.engineerId; }
    },
    {
      key: "AT_RISK", label: "SLA At Risk", icon: "sap-icon://alert", color: "Critical",
      tooltip: "Open incidents approaching their SLA deadline",
      test: function (r) { return r.isOpen && r.slaKey === "DueSoon"; }
    },
    {
      key: "AVG_ASSIGN", label: "Avg Assign Time", icon: "sap-icon://history", color: "Neutral",
      tooltip: "Average time from creation to being routed to a group. Covers only assignments recorded in the change history.",
      compute: function (aRows, oCtrl) {
        var aTimed = aRows.filter(function (r) { return r.assignmentLagMs !== null; });
        if (!aTimed.length) { return "—"; }
        var iSum = aTimed.reduce(function (iAcc, r) { return iAcc + r.assignmentLagMs; }, 0);
        return oCtrl._formatDuration(iSum / aTimed.length);
      }
    }
  ];

  // Column personalization for the ticket view — same pool + localStorage
  // pattern as the Service Desk dashboard's table settings.
  var COLUMN_POOL = [
    { key: "INCIDENT_NUMBER",   label: "Incident #" },
    { key: "SHORT_DESCRIPTION", label: "Short Description" },
    { key: "REPORTER",          label: "Reporter" },
    { key: "CATEGORY",          label: "Category" },
    { key: "PRIORITY",          label: "Priority" },
    { key: "STATUS",            label: "Status" },
    { key: "IMPACT",            label: "Impact" },
    { key: "URGENCY",           label: "Urgency" },
    { key: "GROUP",             label: "Assignment Group" },
    { key: "ENGINEER",          label: "Assigned Engineer" },
    { key: "CREATED_ON",        label: "Created On" },
    { key: "DUE_DATE",          label: "Due Date" },
    { key: "SLA",               label: "SLA Status" }
  ];
  var DEFAULT_COLUMN_KEYS = [
    "INCIDENT_NUMBER", "SHORT_DESCRIPTION", "REPORTER", "PRIORITY",
    "STATUS", "GROUP", "ENGINEER", "CREATED_ON", "SLA"
  ];
  var COLUMN_PREF_KEY = "itsm.serviceGroup.columnKeys";
  var MIN_COLUMNS = 1;
  var MAX_COLUMNS = 9;

  // Row 3 / Row 4 widgets are worklists to act on, not a second copy of the
  // table — five rows each, which is also what keeps the page scroll-free.
  var WIDGET_ROWS = 5;
  var TOP_N = 5;
  var TREND_DAYS = 30;

  // Existing app palettes, reused so this page stays in the same visual
  // language as the other two dashboards.
  var CHART_PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#4a3aa7"];
  var TREND_PALETTE = ["#1d4ed8", "#eda100", "#22c55e"];   // received / assigned / closed
  var SLA_PALETTE = ["#22c55e", "#eda100", "#e34948"];      // met / at risk / breached

  var AGING_BUCKETS = [
    { name: "< 1 day",   max: 1 },
    { name: "1–3 days",  max: 3 },
    { name: "3–7 days",  max: 7 },
    { name: "1–2 weeks", max: 14 },
    { name: "> 2 weeks", max: Infinity }
  ];

  var SLA_STATES = [
    { key: "", text: "Any SLA Status" },
    { key: "OnTrack",  text: "On Track" },
    { key: "DueSoon",  text: "At Risk" },
    { key: "Breached", text: "Breached" },
    { key: "Met",      text: "Met" }
  ];

  var UNASSIGNED_KEY = "__UNASSIGNED__";
  var KEEP_KEY = "";

  var FILTER_SELECT_IDS = [
    "fGroup", "fEngineer", "fCategory", "fPriority", "fStatus",
    "fImpact", "fUrgency", "fSla", "fAge"
  ];
  var FILTER_SEARCH_IDS = ["fSearch", "fReporter"];

  return Controller.extend("itsm.ui.controller.ServiceGroup", {

    /* =========================================================
     * Lifecycle
     * ======================================================= */

    onInit: function () {
      this._aAll = [];
      this._aFiltered = [];
      this._sQuickKey = null;
      this._sCurrentUserId = null;
      this._aSelectedColumnKeys = this._loadColumnPref();

      this.getView().setModel(new JSONModel({
        tiles: this._buildTiles(),
        rows: [],
        charts: { status: [], trend: [], sla: [], categories: [] },
        widgets: { waiting: [], distribution: [], workload: [], breaches: [] },
        counts: { waiting: 0, breaches: 0 },
        opt: {
          teams: [], engineers: [], categories: [], priorities: [], statuses: [],
          impacts: [], urgencies: [], slaStates: SLA_STATES,
          ageBuckets: this._buildAgeOptions(),
          teamsAssignable: [], engineersAssignable: []
        },
        tableTitle: "All Incidents",
        filterSummary: "",
        filterButtonText: "Filters",
        selectionText: "",
        hasSelection: false,
        hasAssignedSelection: false,
        hasSingleSelection: false,
        isTicketMode: false,
        modeButtonText: "Ticket Dashboard",
        modeButtonIcon: "sap-icon://table-view",
        modeButtonTooltip: "Show every incident in a table"
      }), "sg");

      this.getView().setModel(new JSONModel(this._buildColumnVisibility()), "cols");
      this.getView().setModel(new JSONModel({ summary: "" }), "asg");

      // Titles off — VizFrame renders a "Title of Chart" placeholder when no
      // title is set, and each card's own section pill already says what it
      // is. Legends off on the donuts for the same space reason the Service
      // Desk dashboard turns them off: they overflow at this width.
      this._styleChart("statusChart", {
        plotArea: { colorPalette: CHART_PALETTE }, legend: { visible: true }
      });
      this._styleChart("slaChart", {
        plotArea: { colorPalette: SLA_PALETTE }, legend: { visible: true }
      });
      this._styleChart("trendChart", {
        plotArea: { colorPalette: TREND_PALETTE }, legend: { visible: true }
      });
      this._styleChart("categoryChart", {
        plotArea: { colorPalette: CHART_PALETTE, dataLabel: { visible: true } }
      });

      var oRouter = this.getOwnerComponent().getRouter();
      oRouter.getRoute("serviceGroup").attachPatternMatched(this._onMatched, this);
      oRouter.getRoute("serviceGroupTickets").attachPatternMatched(this._onMatched, this);

      this._loadAll();
      this._syncTileClasses();
    },

    onExit: function () {
      if (this._oSortDialog) { this._oSortDialog.destroy(); }
    },

    _styleChart: function (sId, oProps) {
      var oChart = this.byId(sId);
      if (!oChart) { return; }
      oChart.setVizProperties(Object.assign({
        title: { visible: false },
        legend: { visible: false },
        interaction: { noninteractiveMode: false }
      }, oProps));
    },

    _buildAgeOptions: function () {
      var aItems = AGING_BUCKETS.map(function (oBucket) {
        return { key: oBucket.name, text: oBucket.name };
      });
      aItems.unshift({ key: "", text: "Any Age" });
      return aItems;
    },

    /* ---------------------------------------------------------
     * Both routes land here. A mode switch must feel instant, so it
     * deliberately does not refetch — both views read the same
     * in-memory set. Any other arrival (deep link, returning from an
     * incident) reloads so new or edited incidents show up.
     * ------------------------------------------------------- */
    _onMatched: function (oEvent) {
      this._setMode(oEvent.getParameter("name") === "serviceGroupTickets");

      if (this._bModeSwitch) {
        this._bModeSwitch = false;
        return;
      }
      this._loadAll();
    },

    _setMode: function (bTicketMode) {
      var oSg = this.getView().getModel("sg");
      oSg.setProperty("/isTicketMode", bTicketMode);
      oSg.setProperty("/modeButtonText", bTicketMode ? "Analytics" : "Ticket Dashboard");
      oSg.setProperty("/modeButtonIcon", bTicketMode ? "sap-icon://bar-chart" : "sap-icon://table-view");
      oSg.setProperty("/modeButtonTooltip", bTicketMode
        ? "Back to the analytics view"
        : "Show every incident in a table");
    },

    onToggleMode: function () {
      var bToTickets = !this.getView().getModel("sg").getProperty("/isTicketMode");
      this._bModeSwitch = true;
      this.getOwnerComponent().getRouter()
        .navTo(bToTickets ? "serviceGroupTickets" : "serviceGroup");
    },

    /* =========================================================
     * Load
     *
     * Flat fields only, foreign keys resolved against separately
     * fetched master data: getProperty("status/code") over an
     * $expand is not reliable in this v4 model (same approach and
     * reason as Dashboard._loadCounts).
     * ======================================================= */

    _loadAll: function () {
      var that = this;
      var oComponent = this.getOwnerComponent();

      if (!oComponent.getModel("user").getProperty("/isServiceGroup")) { return; }

      // Exactly one load in flight at a time. On first landing both onInit
      // and the route's patternMatched ask for one, and issuing two
      // concurrent identical batches makes the two ODataListBindings share
      // a cache — one of them then resolves empty, which silently blanked
      // the assignment history (and with it "Assigned Today" and the
      // average assignment time).
      if (this._pLoad) { return this._pLoad; }

      var oModel = oComponent.getModel();

      var oLookupB = oModel.bindList("/LookupValues", null, [new Sorter("sequence")], [], {
        $select: "ID,lookupType,code,name"
      });
      var oUserB = oModel.bindList("/Users", null, [new Sorter("name")], [], {
        $select: "ID,name,isActive"
      });
      var oTeamB = oModel.bindList("/SupportTeams", null, [new Sorter("name")], [], {
        $select: "ID,name,isActive"
      });
      var oTicketB = oModel.bindList("/Tickets", null, [], [], {
        $select: [
          "ID", "ticketNumber", "shortDescription",
          "reportedBy_ID", "messageProcessor_ID", "supportTeam_ID",
          "category1_ID", "status_ID", "priority_ID", "impact_ID", "urgency_ID",
          "createdAt", "modifiedAt", "dueAt", "firstResponseAt", "completedAt"
        ].join(",")
      });

      // When an incident was routed to a group. There is no assignedAt
      // column on Ticket, but every supportTeam change is written to the
      // append-only TicketHistory (see srv/handlers/audit.js and
      // assignment.js), so the first such entry IS the assignment moment.
      var oHistB = oModel.bindList("/TicketHistory", null, [], [
        new Filter("fieldName", FilterOperator.EQ, "supportTeam")
      ], { $select: "ID,ticket_ID,newValue,createdAt" });

      this._pLoad = Promise.all([
        oLookupB.requestContexts(0, 2000),
        oUserB.requestContexts(0, 1000),
        oTeamB.requestContexts(0, 500),
        oTicketB.requestContexts(0, 9999),
        oHistB.requestContexts(0, 9999),
        this._requestCurrentUser()
      ]).then(function (aRes) {
        that._indexMasterData(aRes[0], aRes[1], aRes[2]);
        that._indexAssignments(aRes[4]);
        that._sCurrentUserId = aRes[5] && aRes[5].ID;

        that._aAll = aRes[3].map(function (oCtx) { return that._buildRow(oCtx); });

        that._buildFilterOptions();
        that._applyFilters();
        that._pLoad = null;
      }).catch(function (oErr) {
        that._pLoad = null;
        // eslint-disable-next-line no-console
        console.error("Service Group dashboard load failed:", oErr);
        MessageToast.show("Could not load incidents. Please try Refresh.");
      });

      return this._pLoad;
    },

    _requestCurrentUser: function () {
      var oOperation = this.getOwnerComponent().getModel().bindContext("/currentUser(...)");
      return oOperation.execute("$auto").then(function () {
        var oCtx = oOperation.getBoundContext();
        return oCtx ? oCtx.getObject() : null;
      }).catch(function () {
        return null;
      });
    },

    _indexMasterData: function (aLookups, aUsers, aTeams) {
      var that = this;
      this._mLookup = {};
      this._mByType = {};

      aLookups.forEach(function (oCtx) {
        var sType = oCtx.getProperty("lookupType");
        var oEntry = { type: sType, code: oCtx.getProperty("code"), name: oCtx.getProperty("name") };
        that._mLookup[oCtx.getProperty("ID")] = oEntry;
        if (!that._mByType[sType]) { that._mByType[sType] = []; }
        that._mByType[sType].push(oEntry);
      });

      this._mUser = {};
      this._aUsers = aUsers.map(function (oCtx) {
        var o = { ID: oCtx.getProperty("ID"), name: oCtx.getProperty("name"), isActive: oCtx.getProperty("isActive") };
        that._mUser[o.ID] = o;
        return o;
      });

      this._mTeam = {};
      this._aTeams = aTeams.map(function (oCtx) {
        var o = { ID: oCtx.getProperty("ID"), name: oCtx.getProperty("name"), isActive: oCtx.getProperty("isActive") };
        that._mTeam[o.ID] = o;
        return o;
      });
    },

    // ticket ID -> the earliest moment it was routed to a group.
    _indexAssignments: function (aHistory) {
      var mFirst = {};
      aHistory.forEach(function (oCtx) {
        if (!oCtx.getProperty("newValue")) { return; }   // a clearing, not an assignment
        var sTicket = oCtx.getProperty("ticket_ID");
        var iWhen = new Date(oCtx.getProperty("createdAt")).getTime();
        if (isNaN(iWhen)) { return; }
        if (mFirst[sTicket] === undefined || iWhen < mFirst[sTicket]) { mFirst[sTicket] = iWhen; }
      });
      this._mAssignedAt = mFirst;
    },

    /* ---------------------------------------------------------
     * One incident, flattened into everything the KPIs, charts,
     * widgets, filters, table cells and sorters need. Done once per
     * load rather than re-derived on every filter change.
     * ------------------------------------------------------- */
    _buildRow: function (oCtx) {
      var mLookup = this._mLookup;
      function lookup(sId) { return (sId && mLookup[sId]) || null; }

      var oStatus = lookup(oCtx.getProperty("status_ID"));
      var oPriority = lookup(oCtx.getProperty("priority_ID"));
      var oImpact = lookup(oCtx.getProperty("impact_ID"));
      var oUrgency = lookup(oCtx.getProperty("urgency_ID"));
      var oCategory = lookup(oCtx.getProperty("category1_ID"));

      var sID = oCtx.getProperty("ID");
      var sEngineerId = oCtx.getProperty("messageProcessor_ID");
      var sTeamId = oCtx.getProperty("supportTeam_ID");
      var sReporterId = oCtx.getProperty("reportedBy_ID");

      var sCreatedAt = oCtx.getProperty("createdAt");
      var sModifiedAt = oCtx.getProperty("modifiedAt");
      var sDueAt = oCtx.getProperty("dueAt");
      var sCompletedAt = oCtx.getProperty("completedAt");
      var sFirstResponseAt = oCtx.getProperty("firstResponseAt");

      var iCreatedMs = sCreatedAt ? new Date(sCreatedAt).getTime() : null;
      var iNow = Date.now();
      var sPriorityCode = oPriority ? oPriority.code : null;
      var oSla = this._computeSla(sPriorityCode, sCreatedAt, sFirstResponseAt, sCompletedAt);

      var bClosed = !!sCompletedAt ||
        (oStatus && CLOSED_STATUS_CODES.indexOf(oStatus.code) !== -1);
      var iAgeMs = iCreatedMs === null ? 0 : (iNow - iCreatedMs);

      // Only incidents whose routing is actually recorded get a lag; the
      // rest stay null and are excluded from the average rather than
      // guessed at from modifiedAt (which many other edits also touch).
      var iAssignedAt = this._mAssignedAt[sID];
      var iLag = (iAssignedAt !== undefined && iCreatedMs !== null)
        ? Math.max(0, iAssignedAt - iCreatedMs)
        : null;

      return {
        ID: sID,
        ticketNumber: oCtx.getProperty("ticketNumber") || "",
        shortDescription: oCtx.getProperty("shortDescription") || "",

        reporterId: sReporterId,
        reporterName: (this._mUser[sReporterId] && this._mUser[sReporterId].name) || "—",
        engineerId: sEngineerId || null,
        engineerName: (this._mUser[sEngineerId] && this._mUser[sEngineerId].name) || "Unassigned",
        engineerState: sEngineerId ? "None" : "Warning",
        teamId: sTeamId || null,
        teamName: (this._mTeam[sTeamId] && this._mTeam[sTeamId].name) || "Unassigned",

        categoryName: oCategory ? oCategory.name : "Uncategorized",
        statusCode: oStatus ? oStatus.code : null,
        statusName: oStatus ? oStatus.name : "—",
        statusState: this.formatStatusState(oStatus ? oStatus.name : null),
        priorityCode: sPriorityCode,
        priorityName: oPriority ? oPriority.name : "—",
        priorityState: this.formatPriorityState(oPriority ? oPriority.name : null),
        priorityRank: sPriorityCode ? Number(sPriorityCode.slice(1)) : 99,
        impactCode: oImpact ? oImpact.code : null,
        impactName: oImpact ? oImpact.name : "—",
        urgencyCode: oUrgency ? oUrgency.code : null,
        urgencyName: oUrgency ? oUrgency.name : "—",

        createdAt: sCreatedAt,
        createdMs: iCreatedMs,
        createdText: this.formatDateTime(sCreatedAt),
        modifiedMs: sModifiedAt ? new Date(sModifiedAt).getTime() : 0,
        modifiedText: this.formatDateTime(sModifiedAt),
        dueAtMs: sDueAt ? new Date(sDueAt).getTime() : null,
        dueText: sDueAt ? this.formatDateTime(sDueAt) : "—",
        completedMs: sCompletedAt ? new Date(sCompletedAt).getTime() : null,

        assignedAtMs: iAssignedAt === undefined ? null : iAssignedAt,
        assignmentLagMs: iLag,
        assignedToday: iAssignedAt !== undefined && this._isToday(iAssignedAt),

        slaText: oSla.text,
        slaState: oSla.state,
        slaKey: oSla.key,
        slaRank: ["Breached", "DueSoon", "OnTrack", "Met", "None"].indexOf(oSla.key),
        deadlineText: oSla.deadline ? this._formatTimeLeft(oSla.deadline - iNow) : "—",
        deadline: oSla.deadline || Infinity,

        isOpen: !bClosed,
        isInProgress: !!oStatus && oStatus.code === IN_PROGRESS_STATUS_CODE,
        // A resolution cannot precede its own creation. Sample data whose
        // completedAt predates the row's managed createdAt would otherwise
        // average out to a negative "Avg Resolution" — report it as unknown
        // rather than print a nonsense duration.
        resolutionMs: this._elapsed(iCreatedMs, sCompletedAt),
        ageMs: iAgeMs,
        ageText: this._formatDuration(iAgeMs),
        ageDays: iAgeMs / 86400000,
        waitingText: iCreatedMs === null ? "—" : this._formatDuration(iAgeMs) + " ago"
      };
    },

    // Milliseconds between a start and an end, or null when either is
    // missing or the pair is not in chronological order.
    _elapsed: function (iStartMs, vEnd) {
      if (iStartMs === null || !vEnd) { return null; }
      var iEnd = new Date(vEnd).getTime();
      if (isNaN(iEnd)) { return null; }
      var iDiff = iEnd - iStartMs;
      return iDiff < 0 ? null : iDiff;
    },

    _isToday: function (vValue) {
      var oDate = new Date(vValue);
      var oToday = new Date();
      return oDate.getFullYear() === oToday.getFullYear() &&
             oDate.getMonth() === oToday.getMonth() &&
             oDate.getDate() === oToday.getDate();
    },

    /* =========================================================
     * Filter options — built from master data already fetched, so
     * no second round of requests just to fill the dropdowns.
     * ======================================================= */

    _buildFilterOptions: function () {
      function fromLookup(aEntries, sAllLabel) {
        var aItems = (aEntries || []).map(function (o) { return { key: o.code, text: o.name }; });
        aItems.unshift({ key: "", text: sAllLabel });
        return aItems;
      }

      var aTeams = this._aTeams.map(function (o) { return { key: o.ID, text: o.name }; });
      var aEngineers = this._aUsers
        .filter(function (o) { return o.isActive !== false; })
        .map(function (o) { return { key: o.ID, text: o.name }; });

      this.getView().getModel("sg").setProperty("/opt", {
        teams: [{ key: "", text: "All Groups" }, { key: UNASSIGNED_KEY, text: "— Unassigned —" }].concat(aTeams),
        engineers: [{ key: "", text: "All Engineers" }, { key: UNASSIGNED_KEY, text: "— Unassigned —" }].concat(aEngineers),
        categories: fromLookup(this._mByType.CATEGORY1, "All Categories"),
        priorities: fromLookup(this._mByType.PRIORITY, "All Priorities"),
        statuses: fromLookup(this._mByType.STATUS, "All Statuses"),
        impacts: fromLookup(this._mByType.IMPACT, "All Impacts"),
        urgencies: fromLookup(this._mByType.URGENCY, "All Urgencies"),
        slaStates: SLA_STATES,
        ageBuckets: this._buildAgeOptions(),
        // The assignment dialog writes values rather than filtering by them,
        // so it needs a "leave as-is" entry instead of an "all" entry.
        teamsAssignable: [{ key: KEEP_KEY, text: "(keep unchanged)" }].concat(aTeams),
        engineersAssignable: [{ key: KEEP_KEY, text: "(keep unchanged)" }].concat(aEngineers)
      });
    },

    /* =========================================================
     * Filtering — one pass produces the selection every KPI,
     * chart, widget and the ticket table are derived from.
     * ======================================================= */

    _readFilters: function () {
      var oCreated = this.byId("fCreated");
      var oFrom = oCreated.getDateValue();
      var oTo = oCreated.getSecondDateValue();

      // The picker returns midnight for both ends; push the upper bound to
      // the end of that day so "between the 1st and the 1st" still matches
      // incidents raised during the 1st.
      var iTo = null;
      if (oTo) {
        var oEnd = new Date(oTo.getTime());
        oEnd.setHours(23, 59, 59, 999);
        iTo = oEnd.getTime();
      }

      return {
        team: this.byId("fGroup").getSelectedKey(),
        engineer: this.byId("fEngineer").getSelectedKey(),
        category: this.byId("fCategory").getSelectedKey(),
        priority: this.byId("fPriority").getSelectedKey(),
        status: this.byId("fStatus").getSelectedKey(),
        impact: this.byId("fImpact").getSelectedKey(),
        urgency: this.byId("fUrgency").getSelectedKey(),
        sla: this.byId("fSla").getSelectedKey(),
        age: this.byId("fAge").getSelectedKey(),
        from: oFrom ? oFrom.getTime() : null,
        to: iTo,
        search: (this.byId("fSearch").getValue() || "").trim().toLowerCase(),
        reporter: (this.byId("fReporter").getValue() || "").trim().toLowerCase()
      };
    },

    _matches: function (oRow, oF, oQuickTile) {
      if (oF.team === UNASSIGNED_KEY) { if (oRow.teamId) { return false; } }
      else if (oF.team && oRow.teamId !== oF.team) { return false; }

      if (oF.engineer === UNASSIGNED_KEY) { if (oRow.engineerId) { return false; } }
      else if (oF.engineer && oRow.engineerId !== oF.engineer) { return false; }

      if (oF.category && oRow.categoryName !== oF.category) { return false; }
      if (oF.priority && oRow.priorityCode !== oF.priority) { return false; }
      if (oF.status && oRow.statusCode !== oF.status) { return false; }
      if (oF.impact && oRow.impactCode !== oF.impact) { return false; }
      if (oF.urgency && oRow.urgencyCode !== oF.urgency) { return false; }
      if (oF.sla && oRow.slaKey !== oF.sla) { return false; }

      // Age describes how long something has been open, so a completed
      // incident is never in a bucket.
      if (oF.age) {
        if (!oRow.isOpen) { return false; }
        var iBucket = AGING_BUCKETS.map(function (b) { return b.name; }).indexOf(oF.age);
        if (iBucket === -1) { return false; }
        var iMin = iBucket === 0 ? 0 : AGING_BUCKETS[iBucket - 1].max;
        if (oRow.ageDays < iMin || oRow.ageDays >= AGING_BUCKETS[iBucket].max) { return false; }
      }

      if (oF.from !== null && (oRow.createdMs === null || oRow.createdMs < oF.from)) { return false; }
      if (oF.to !== null && (oRow.createdMs === null || oRow.createdMs > oF.to)) { return false; }

      if (oF.search &&
          oRow.ticketNumber.toLowerCase().indexOf(oF.search) === -1 &&
          oRow.shortDescription.toLowerCase().indexOf(oF.search) === -1) { return false; }

      if (oF.reporter && oRow.reporterName.toLowerCase().indexOf(oF.reporter) === -1) { return false; }

      if (oQuickTile && oQuickTile.test && !oQuickTile.test(oRow)) { return false; }

      return true;
    },

    _applyFilters: function () {
      var that = this;
      var oF = this._readFilters();
      var oQuickTile = this._sQuickKey && this._findTile(this._sQuickKey);

      this._aFiltered = this._aAll.filter(function (oRow) {
        return that._matches(oRow, oF, oQuickTile);
      });

      var iActive = this._countActiveFilters(oF, oQuickTile);
      var oSg = this.getView().getModel("sg");
      oSg.setProperty("/rows", this._aFiltered);
      oSg.setProperty("/tableTitle", oQuickTile ? oQuickTile.label + " Incidents" : "All Incidents");
      oSg.setProperty("/filterSummary", this._describeFilters(iActive));
      oSg.setProperty("/filterButtonText", iActive ? "Filters (" + iActive + ")" : "Filters");

      this._updateTiles(oF);
      this._updateCharts();
      this._updateWidgets();
      this._clearSelection();
    },

    _countActiveFilters: function (oF, oQuickTile) {
      var iActive = oQuickTile ? 1 : 0;
      Object.keys(oF).forEach(function (sKey) {
        var v = oF[sKey];
        if (v !== null && v !== "" && v !== undefined) { iActive++; }
      });
      return iActive;
    },

    _describeFilters: function (iActive) {
      var iShown = this._aFiltered.length;
      var iTotal = this._aAll.length;
      if (iActive === 0) { return iTotal + " incidents"; }
      return iShown + " of " + iTotal + " incidents · " + iActive + (iActive === 1 ? " filter" : " filters");
    },

    /* ---------------------------------------------------------
     * Row 1 — KPIs. Counts are computed over the set the *other*
     * filters produce but ignoring the pressed tile itself, so
     * pressing one does not drive every other tile to zero.
     * ------------------------------------------------------- */
    _updateTiles: function (oF) {
      var that = this;
      var aBase = this._aAll.filter(function (oRow) { return that._matches(oRow, oF, null); });

      var iNow = Date.now();
      var WEEK_MS = 7 * 86400000;
      function weekBucket(iCreatedMs) {
        if (iCreatedMs === null) { return null; }
        var iAge = iNow - iCreatedMs;
        if (iAge < WEEK_MS) { return "this"; }
        if (iAge < 2 * WEEK_MS) { return "last"; }
        return null;
      }

      var oSg = this.getView().getModel("sg");
      var aTiles = oSg.getProperty("/tiles").map(function (oTile) {
        var oDef = that._findTile(oTile.key);

        if (!oDef.test) {
          oTile.value = oDef.compute(aBase, that);
          oTile.trendLabel = "";
          oTile.trendDirection = "None";
          oTile.selected = false;
          return oTile;
        }

        var iCount = 0, iThisWeek = 0, iLastWeek = 0;
        aBase.forEach(function (oRow) {
          if (!oDef.test(oRow)) { return; }
          iCount++;
          var sBucket = weekBucket(oRow.createdMs);
          if (sBucket === "this") { iThisWeek++; }
          else if (sBucket === "last") { iLastWeek++; }
        });

        var oTrend = that._formatTrend(iThisWeek, iLastWeek);
        oTile.value = String(iCount);
        oTile.trendLabel = oTrend.label;
        oTile.trendDirection = oTrend.direction;
        oTile.selected = (oTile.key === that._sQuickKey);
        return oTile;
      });

      oSg.setProperty("/tiles", aTiles);
      this._syncTileClasses();
    },

    /* ---------------------------------------------------------
     * Row 2 — the three analytics cards.
     * ------------------------------------------------------- */
    _updateCharts: function () {
      var oSg = this.getView().getModel("sg");
      var aRows = this._aFiltered;

      oSg.setProperty("/charts/status", this._countBy(aRows, "statusName"));
      oSg.setProperty("/charts/sla", this._buildSlaChart(aRows));
      oSg.setProperty("/charts/trend", this._buildTrendChart(aRows));
      oSg.setProperty("/charts/categories", this._countBy(aRows, "categoryName", TOP_N));
    },

    _countBy: function (aRows, sField, iTopN) {
      var mCount = {};
      aRows.forEach(function (oRow) {
        var sName = oRow[sField] || "—";
        mCount[sName] = (mCount[sName] || 0) + 1;
      });
      var aData = Object.keys(mCount).map(function (sName) {
        return { name: sName, count: mCount[sName] };
      }).sort(function (a, b) { return b.count - a.count; });
      return iTopN ? aData.slice(0, iTopN) : aData;
    },

    // Order must match SLA_PALETTE (green / amber / red).
    _buildSlaChart: function (aRows) {
      var iMet = 0, iRisk = 0, iBreached = 0;
      aRows.forEach(function (oRow) {
        if (oRow.slaKey === "Breached") { iBreached++; }
        else if (oRow.slaKey === "DueSoon") { iRisk++; }
        else if (oRow.slaKey === "Met" || oRow.slaKey === "OnTrack") { iMet++; }
      });
      return [
        { name: "Met", count: iMet },
        { name: "At Risk", count: iRisk },
        { name: "Breached", count: iBreached }
      ];
    },

    // Received / assigned / closed per day over the last 30 days.
    _buildTrendChart: function (aRows) {
      var oStart = new Date();
      oStart.setHours(0, 0, 0, 0);
      var iDayMs = 86400000;
      var iEnd = oStart.getTime() + iDayMs;
      var iBegin = iEnd - TREND_DAYS * iDayMs;

      var aData = [];
      for (var i = 0; i < TREND_DAYS; i++) {
        var oDate = new Date(iBegin + i * iDayMs);
        aData.push({
          date: oDate.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
          received: 0, assigned: 0, closed: 0
        });
      }

      function bucketIndex(iMs) {
        if (iMs === null || iMs === undefined || iMs < iBegin || iMs >= iEnd) { return -1; }
        return Math.floor((iMs - iBegin) / iDayMs);
      }

      aRows.forEach(function (oRow) {
        var i1 = bucketIndex(oRow.createdMs);
        if (i1 >= 0) { aData[i1].received++; }
        var i2 = bucketIndex(oRow.assignedAtMs);
        if (i2 >= 0) { aData[i2].assigned++; }
        var i3 = bucketIndex(oRow.completedMs);
        if (i3 >= 0) { aData[i3].closed++; }
      });

      return aData;
    },

    /* ---------------------------------------------------------
     * Rows 3 and 4 — the worklist widgets.
     * ------------------------------------------------------- */
    _updateWidgets: function () {
      var that = this;
      var oSg = this.getView().getModel("sg");
      var aRows = this._aFiltered;

      // Waiting for the Service Group's own action: no assignment group yet.
      var aWaiting = aRows.filter(function (r) { return r.isOpen && !r.teamId; })
        .sort(function (a, b) { return b.createdMs - a.createdMs; });
      oSg.setProperty("/widgets/waiting", aWaiting.slice(0, WIDGET_ROWS));
      oSg.setProperty("/counts/waiting", aWaiting.length);

      // Per assignment group. Two views of the same grouping, because they
      // answer different questions: distribution is about routing (what have
      // we handed over, what is still sitting there), workload is about the
      // group's own throughput.
      var mGroup = {};
      function bucket(sName) {
        if (!mGroup[sName]) {
          mGroup[sName] = {
            name: sName, assigned: 0, pending: 0, open: 0, inProgress: 0,
            queueSum: 0, queueCount: 0, resSum: 0, resCount: 0
          };
        }
        return mGroup[sName];
      }

      aRows.forEach(function (r) {
        if (!r.teamId) { return; }
        var o = bucket(r.teamName);
        o.assigned++;
        if (r.isOpen) {
          o.open++;
          o.queueSum += r.ageMs;
          o.queueCount++;
          if (!r.engineerId) { o.pending++; }
          if (r.isInProgress) { o.inProgress++; }
        }
        if (r.resolutionMs !== null) { o.resSum += r.resolutionMs; o.resCount++; }
      });

      var aGroups = Object.keys(mGroup).map(function (sName) { return mGroup[sName]; });

      oSg.setProperty("/widgets/distribution", aGroups
        .slice()
        .sort(function (a, b) { return b.assigned - a.assigned; })
        .slice(0, TOP_N)
        .map(function (o) {
          return {
            name: o.name,
            assigned: o.assigned,
            pending: o.pending,
            pendingState: o.pending === 0 ? "Success" : (o.pending > 5 ? "Error" : "Warning"),
            avgQueue: o.queueCount ? that._formatDuration(o.queueSum / o.queueCount) : "—"
          };
        }));

      oSg.setProperty("/widgets/workload", aGroups
        .slice()
        .sort(function (a, b) { return b.open - a.open; })
        .slice(0, TOP_N)
        .map(function (o) {
          return {
            name: o.name,
            open: o.open,
            inProgress: o.inProgress,
            avgResolution: o.resCount ? that._formatDuration(o.resSum / o.resCount) : "—"
          };
        }));

      // Most recently raised of the incidents that have breached.
      var aBreaches = aRows.filter(function (r) { return r.slaKey === "Breached"; })
        .sort(function (a, b) { return b.createdMs - a.createdMs; });
      oSg.setProperty("/widgets/breaches", aBreaches.slice(0, WIDGET_ROWS));
      oSg.setProperty("/counts/breaches", aBreaches.length);
    },

    /* =========================================================
     * Tiles
     * ======================================================= */

    _buildTiles: function () {
      return TILES.map(function (oTile) {
        return {
          key: oTile.key, label: oTile.label, icon: oTile.icon,
          color: oTile.color, tooltip: oTile.tooltip,
          pressable: !!oTile.test,
          value: oTile.test ? "0" : "—",
          trendLabel: "", trendDirection: "None", selected: false
        };
      });
    },

    _findTile: function (sKey) {
      for (var i = 0; i < TILES.length; i++) {
        if (TILES[i].key === sKey) { return TILES[i]; }
      }
      return null;
    },

    // Binding GenericTile's "class" attribute silently fails to resolve in
    // this UI5 build, and sap.m.HBox has no updateFinished event to hook —
    // so the accent and selection classes go on the real control instances
    // every time the tiles model changes.
    _syncTileClasses: function () {
      var oHBox = this.byId("tileRow");
      if (!oHBox) { return; }
      oHBox.getItems().forEach(function (oWrap, i) {
        var oTile = oWrap.getItems()[0];
        var oBadge = oWrap.getItems()[1];
        oTile.addStyleClass("acc" + (i + 1));
        var oCtx = oTile.getBindingContext("sg");
        oTile.toggleStyleClass("kpiSel", !!(oCtx && oCtx.getProperty("selected")));
        oTile.toggleStyleClass("kpiStatic", !!(oCtx && !oCtx.getProperty("pressable")));
        if (oBadge && oCtx) {
          oBadge.toggleStyleClass("trendUp", oCtx.getProperty("trendDirection") === "Up");
          oBadge.toggleStyleClass("trendDown", oCtx.getProperty("trendDirection") === "Down");
        }
      });
    },

    // Pressing the active tile again clears it, so a tile is a toggle rather
    // than a trap you can only leave via Reset.
    onTilePress: function (oEvent) {
      var oCtx = oEvent.getSource().getBindingContext("sg");
      if (!oCtx || !oCtx.getProperty("pressable")) { return; }
      var sKey = oCtx.getProperty("key");
      this._sQuickKey = (this._sQuickKey === sKey) ? null : sKey;
      this._applyFilters();
    },

    /* =========================================================
     * Slide-out filter panel
     *
     * Values are staged here and only take effect on Apply, so a
     * half-typed search never churns six KPIs and four charts.
     * Cancel restores whatever was in force when it was opened.
     * ======================================================= */

    onOpenFilters: function () {
      this._oFilterSnapshot = this._snapshotFilters();
      this.byId("filterPane").addStyleClass("filterOpen");
      this.byId("filterFab").setVisible(false);
    },

    _closeFilters: function () {
      this.byId("filterPane").removeStyleClass("filterOpen");
      this.byId("filterFab").setVisible(true);
    },

    onApplyFilters: function () {
      this._closeFilters();
      this._applyFilters();
    },

    onCancelFilters: function () {
      if (this._oFilterSnapshot) { this._restoreFilters(this._oFilterSnapshot); }
      this._closeFilters();
    },

    _snapshotFilters: function () {
      var that = this;
      var oSnapshot = { selects: {}, searches: {} };
      FILTER_SELECT_IDS.forEach(function (sId) {
        oSnapshot.selects[sId] = that.byId(sId).getSelectedKey();
      });
      FILTER_SEARCH_IDS.forEach(function (sId) {
        oSnapshot.searches[sId] = that.byId(sId).getValue();
      });
      oSnapshot.from = this.byId("fCreated").getDateValue();
      oSnapshot.to = this.byId("fCreated").getSecondDateValue();
      oSnapshot.quickKey = this._sQuickKey;
      return oSnapshot;
    },

    _restoreFilters: function (oSnapshot) {
      var that = this;
      FILTER_SELECT_IDS.forEach(function (sId) {
        that.byId(sId).setSelectedKey(oSnapshot.selects[sId]);
      });
      FILTER_SEARCH_IDS.forEach(function (sId) {
        that.byId(sId).setValue(oSnapshot.searches[sId]);
      });
      this.byId("fCreated").setDateValue(oSnapshot.from);
      this.byId("fCreated").setSecondDateValue(oSnapshot.to);
      this._sQuickKey = oSnapshot.quickKey;
    },

    // Clears everything, including a pressed KPI tile. The panel stays open
    // so a fresh selection can be built without reopening it.
    onResetFilters: function () {
      var that = this;
      this._sQuickKey = null;
      FILTER_SELECT_IDS.forEach(function (sId) { that.byId(sId).setSelectedKey(""); });
      FILTER_SEARCH_IDS.forEach(function (sId) { that.byId(sId).setValue(""); });
      this.byId("fCreated").setDateValue(null);
      this.byId("fCreated").setSecondDateValue(null);

      [this.byId("statusChart"), this.byId("slaChart")].forEach(function (oChart) {
        if (oChart && oChart.vizSelection) { oChart.vizSelection([]); }
      });

      this._applyFilters();
    },

    /* =========================================================
     * Chart drill-down — a click pushes the value into the matching
     * filter, so every other card follows along rather than the
     * chart holding a selection of its own.
     * ======================================================= */

    _chartSelectValue: function (oEvent, sDimension) {
      var aData = oEvent.getParameter("data");
      if (!aData || !aData.length || !aData[0].data) { return null; }
      return aData[0].data[sDimension];
    },

    onStatusChartSelect: function (oEvent) {
      var sName = this._chartSelectValue(oEvent, "Status");
      if (!sName) { return; }
      var oMatch = (this._mByType.STATUS || []).filter(function (o) { return o.name === sName; })[0];
      if (oMatch) { this.byId("fStatus").setSelectedKey(oMatch.code); this._applyFilters(); }
    },

    onSlaChartSelect: function (oEvent) {
      var sName = this._chartSelectValue(oEvent, "SLA");
      var mKey = { "Met": "OnTrack", "At Risk": "DueSoon", "Breached": "Breached" };
      if (mKey[sName]) { this.byId("fSla").setSelectedKey(mKey[sName]); this._applyFilters(); }
    },

    onCategoryChartSelect: function (oEvent) {
      var sName = this._chartSelectValue(oEvent, "Category");
      if (sName) { this.byId("fCategory").setSelectedKey(sName); this._applyFilters(); }
    },

    /* =========================================================
     * Quick actions — every one lands somewhere real.
     * ======================================================= */

    // Assign / Bulk Assign / Reassign all need a selection to act on, so
    // they open the ticket view pre-filtered to the right candidates rather
    // than opening a dialog with nothing in it.
    onQuickAssign: function () {
      this._quickTo(null, "Select incidents, then press Assign.");
    },

    onQuickBulkAssign: function () {
      this.byId("fGroup").setSelectedKey(UNASSIGNED_KEY);
      this._quickTo("UNASSIGNED", "Unassigned incidents — select several and press Assign.");
    },

    onQuickReassign: function () {
      this.byId("fGroup").setSelectedKey("");
      this._quickTo("PENDING", "Routed but not picked up — select and press Reassign or Change Group.");
    },

    onQuickViewQueue: function () {
      this.byId("fGroup").setSelectedKey(UNASSIGNED_KEY);
      this._quickTo("UNASSIGNED", "The Service Group assignment queue.");
    },

    onQuickSlaDashboard: function () {
      this.getOwnerComponent().getRouter().navTo("analytics");
    },

    _quickTo: function (sTileKey, sHint) {
      this._sQuickKey = sTileKey;
      this._applyFilters();
      if (!this.getView().getModel("sg").getProperty("/isTicketMode")) {
        this.onToggleMode();
      }
      MessageToast.show(sHint);
    },

    /* =========================================================
     * Widget navigation
     * ======================================================= */

    onWidgetItemPress: function (oEvent) {
      var oItem = oEvent.getParameter("listItem") || oEvent.getSource();
      var oCtx = oItem.getBindingContext("sg");
      if (oCtx && oCtx.getProperty("ID")) { this._navToIncident(oCtx.getProperty("ID")); }
    },

    // Clicking a group row filters the whole dashboard to that group.
    onGroupRowPress: function (oEvent) {
      var oItem = oEvent.getParameter("listItem") || oEvent.getSource();
      var oCtx = oItem.getBindingContext("sg");
      if (!oCtx) { return; }
      var sName = oCtx.getProperty("name");
      var oTeam = this._aTeams.filter(function (t) { return t.name === sName; })[0];
      if (oTeam) { this.byId("fGroup").setSelectedKey(oTeam.ID); this._applyFilters(); }
    },

    /* =========================================================
     * Selection + assignment (ticket view)
     * ======================================================= */

    onSelectionChange: function () {
      this._refreshSelectionState();
    },

    _selectedRows: function () {
      return this.byId("incidentTable").getSelectedItems().map(function (oItem) {
        return oItem.getBindingContext("sg").getObject();
      });
    },

    _refreshSelectionState: function () {
      var aRows = this._selectedRows();
      var oSg = this.getView().getModel("sg");
      oSg.setProperty("/hasSelection", aRows.length > 0);
      oSg.setProperty("/hasSingleSelection", aRows.length === 1);
      oSg.setProperty("/hasAssignedSelection", aRows.some(function (r) { return !!r.engineerId; }));
      oSg.setProperty("/selectionText", aRows.length ? aRows.length + " selected" : "");
    },

    _clearSelection: function () {
      var oTable = this.byId("incidentTable");
      if (oTable) { oTable.removeSelections(true); }
      this._refreshSelectionState();
    },

    // Assign / Reassign / Change Group are the same dialog with a different
    // preamble — one code path, so a bulk reassign cannot behave differently
    // from a single assign.
    onAssignSelected: function () { this._openAssignDialog("assign"); },
    onReassignSelected: function () { this._openAssignDialog("reassign"); },
    onChangeGroupSelected: function () { this._openAssignDialog("group"); },

    _openAssignDialog: function (sMode) {
      var aRows = this._selectedRows();
      if (!aRows.length) { return; }

      this._sAssignMode = sMode;
      var oDialog = this.byId("assignDialog");
      var bBulk = aRows.length > 1;

      var sSummary;
      if (sMode === "group") {
        sSummary = bBulk
          ? "Move " + aRows.length + " incidents to a different assignment group."
          : "Move " + aRows[0].ticketNumber + " to a different assignment group.";
      } else if (sMode === "reassign") {
        sSummary = bBulk
          ? "Reassign " + aRows.length + " incidents to a different engineer."
          : aRows[0].ticketNumber + " is currently with " + aRows[0].engineerName + ".";
      } else {
        sSummary = bBulk
          ? "Assign " + aRows.length + " incidents."
          : "Assign " + aRows[0].ticketNumber + " — " + aRows[0].shortDescription;
      }

      oDialog.setTitle(sMode === "group"
        ? "Change Assignment Group"
        : (bBulk ? "Bulk Assign Incidents" : "Assign Incident"));
      this.getView().getModel("asg").setProperty("/summary", sSummary);

      this.byId("assignEngineerSelect").setSelectedKey(this._sharedValue(aRows, "engineerId"));
      this.byId("assignTeamSelect").setSelectedKey(this._sharedValue(aRows, "teamId"));

      oDialog.open();
    },

    // The value every selected row shares for a field, or "" when they
    // differ — which is exactly the dialog's "(keep unchanged)" key.
    _sharedValue: function (aRows, sField) {
      var vFirst = aRows[0][sField] || "";
      return aRows.every(function (r) { return (r[sField] || "") === vFirst; }) ? vFirst : "";
    },

    onCancelAssign: function () {
      this.byId("assignDialog").close();
    },

    onConfirmAssign: function () {
      var that = this;
      var aRows = this._selectedRows();
      if (!aRows.length) { return; }

      var sEngineer = this.byId("assignEngineerSelect").getSelectedKey();
      var sTeam = this.byId("assignTeamSelect").getSelectedKey();

      if (!sEngineer && !sTeam) {
        MessageToast.show("Choose an engineer, an assignment group, or both.");
        return;
      }

      var oModel = this.getOwnerComponent().getModel();
      var oOperation = oModel.bindContext("/assignTickets(...)");
      oOperation.setParameter("tickets", aRows.map(function (r) { return r.ID; }));
      if (sEngineer) { oOperation.setParameter("messageProcessor", sEngineer); }
      if (sTeam) { oOperation.setParameter("supportTeam", sTeam); }

      // "$auto" explicitly: the model's updateGroupId is a deferred group
      // (itsmGroup, for the draft-based forms), and an action left in it
      // would sit unsent until something submits that batch.
      oOperation.execute("$auto").then(function () {
        var oResult = oOperation.getBoundContext();
        var vValue = oResult && oResult.getObject();
        var iChanged = (vValue && typeof vValue === "object") ? vValue.value : vValue;

        that.byId("assignDialog").close();
        MessageToast.show(iChanged
          ? iChanged + " incident(s) updated."
          : "Nothing to change — the selection already had those values.");
        that._loadAll();
      }).catch(function (oErr) {
        // eslint-disable-next-line no-console
        console.error("Assignment failed:", oErr);
        MessageBox.error("Could not assign the selected incidents.\n\n" +
          ((oErr && oErr.message) || "Please try again."));
      });
    },

    /* =========================================================
     * Sorting + column personalization (ticket view)
     * ======================================================= */

    onOpenSort: function () {
      if (!this._oSortDialog) {
        this._oSortDialog = new ViewSettingsDialog({
          confirm: this.onSortConfirm.bind(this),
          sortItems: [
            new ViewSettingsItem({ key: "createdMs", text: "Created On", selected: true }),
            new ViewSettingsItem({ key: "ticketNumber", text: "Incident #" }),
            new ViewSettingsItem({ key: "priorityRank", text: "Priority" }),
            new ViewSettingsItem({ key: "statusName", text: "Status" }),
            new ViewSettingsItem({ key: "slaRank", text: "SLA Status" }),
            new ViewSettingsItem({ key: "ageMs", text: "Age" }),
            new ViewSettingsItem({ key: "engineerName", text: "Assigned Engineer" }),
            new ViewSettingsItem({ key: "teamName", text: "Assignment Group" })
          ]
        });
        this._oSortDialog.setSortDescending(true);
        this.getView().addDependent(this._oSortDialog);
      }
      this._oSortDialog.open();
    },

    onSortConfirm: function (oEvent) {
      var oItem = oEvent.getParameter("sortItem");
      if (!oItem) { return; }
      this.byId("incidentTable").getBinding("items")
        .sort(new Sorter(oItem.getKey(), oEvent.getParameter("sortDescending")));
    },

    _loadColumnPref: function () {
      try {
        var sSaved = window.localStorage.getItem(COLUMN_PREF_KEY);
        var aSaved = sSaved && JSON.parse(sSaved);
        if (Array.isArray(aSaved) && aSaved.length >= MIN_COLUMNS && aSaved.length <= MAX_COLUMNS &&
            aSaved.every(function (sKey) { return COLUMN_POOL.some(function (c) { return c.key === sKey; }); })) {
          return aSaved;
        }
      } catch (e) { /* malformed or blocked storage — fall back below */ }
      return DEFAULT_COLUMN_KEYS.slice();
    },

    _saveColumnPref: function (aKeys) {
      try {
        window.localStorage.setItem(COLUMN_PREF_KEY, JSON.stringify(aKeys));
      } catch (e) { /* storage unavailable — the choice just won't persist */ }
    },

    _buildColumnVisibility: function () {
      var that = this;
      var oVisible = {};
      COLUMN_POOL.forEach(function (c) {
        oVisible[c.key] = that._aSelectedColumnKeys.indexOf(c.key) !== -1;
      });
      return oVisible;
    },

    onManageColumns: function () {
      var aSelected = this._aSelectedColumnKeys;
      var aAllColumns = COLUMN_POOL.map(function (c) {
        return { key: c.key, label: c.label, selected: aSelected.indexOf(c.key) !== -1 };
      });

      this.getView().setModel(new JSONModel({
        allColumns: aAllColumns,
        selectedCount: aSelected.length,
        maxColumns: MAX_COLUMNS,
        canSave: aSelected.length >= MIN_COLUMNS && aSelected.length <= MAX_COLUMNS
      }), "cp");

      this.byId("columnDialog").open();
    },

    onColumnPickerSelectionChange: function (oEvent) {
      var oList = this.byId("columnPickerList");
      var oCp = this.getView().getModel("cp");
      var aAllColumns = oCp.getProperty("/allColumns");
      var iSelected = 0;

      oList.getItems().forEach(function (oItem, i) {
        aAllColumns[i].selected = oItem.getSelected();
        if (aAllColumns[i].selected) { iSelected++; }
      });

      if (iSelected > MAX_COLUMNS) {
        var oChanged = oEvent.getParameter("listItem");
        var iIndex = oList.indexOfItem(oChanged);
        oChanged.setSelected(false);
        aAllColumns[iIndex].selected = false;
        iSelected--;
        MessageToast.show("You can show at most " + MAX_COLUMNS + " columns at once.");
      }

      oCp.setProperty("/allColumns", aAllColumns);
      oCp.setProperty("/selectedCount", iSelected);
      oCp.setProperty("/canSave", iSelected >= MIN_COLUMNS && iSelected <= MAX_COLUMNS);
    },

    onSaveColumns: function () {
      var aAllColumns = this.getView().getModel("cp").getProperty("/allColumns");
      this._aSelectedColumnKeys = aAllColumns
        .filter(function (c) { return c.selected; })
        .map(function (c) { return c.key; });

      this._saveColumnPref(this._aSelectedColumnKeys);
      this.byId("columnDialog").close();
      this.getView().getModel("cols").setData(this._buildColumnVisibility());
    },

    onCancelColumns: function () {
      this.byId("columnDialog").close();
    },

    /* =========================================================
     * Navigation + misc
     * ======================================================= */

    onRefresh: function () {
      this._loadAll();
      MessageToast.show("Reloading incidents…");
    },

    onTicketPress: function (oEvent) {
      var oItem = oEvent.getParameter("listItem") || oEvent.getSource();
      var oCtx = oItem.getBindingContext("sg");
      if (oCtx) { this._navToIncident(oCtx.getProperty("ID")); }
    },

    onOpenSelected: function () {
      var aRows = this._selectedRows();
      if (aRows.length === 1) { this._navToIncident(aRows[0].ID); }
    },

    _navToIncident: function (sId) {
      this.getOwnerComponent().getRouter().navTo("detail", { id: sId });
    },

    onGoDashboard: function () {
      this.getOwnerComponent().getRouter().navTo("dashboard");
    },

    /* =========================================================
     * Formatting — same semantics as the Dashboard/Analytics
     * controllers, so a badge means the same thing on every page.
     * ======================================================= */

    formatDateTime: function (sValue) {
      if (!sValue) { return ""; }
      var oDate = new Date(sValue);
      return isNaN(oDate.getTime()) ? "" : oDate.toLocaleString();
    },

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

    formatPriorityState: function (sName) {
      if (!sName) { return "None"; }
      if (sName.indexOf("P1") === 0) { return "Error"; }
      if (sName.indexOf("P2") === 0) { return "Warning"; }
      if (sName.indexOf("P3") === 0) { return "Information"; }
      return "None";
    },

    _formatDuration: function (iMs) {
      var iMinutes = iMs / 60000;
      if (iMinutes < 60) { return Math.round(iMinutes) + "m"; }
      var iHours = iMs / 3600000;
      if (iHours < 24) { return iHours.toFixed(1) + "h"; }
      return (iHours / 24).toFixed(1) + "d";
    },

    _formatTimeLeft: function (iMs) {
      if (iMs <= 0) { return "Overdue"; }
      var iMinutes = iMs / 60000;
      if (iMinutes < 60) { return Math.round(iMinutes) + "m left"; }
      var iHours = iMs / 3600000;
      if (iHours < 24) { return iHours.toFixed(1) + "h left"; }
      return (iHours / 24).toFixed(1) + "d left";
    },

    // Plain Unicode arrows rather than the SAP icon font — no glyph-name
    // guessing, full control over size. "Nothing to compare against" reads
    // as "all new" instead of a divide-by-zero percentage.
    _formatTrend: function (iThisWeek, iLastWeek) {
      if (iLastWeek === 0) {
        return iThisWeek > 0
          ? { direction: "Up", label: "▲ all new" }
          : { direction: "None", label: "" };
      }
      var iPct = Math.round((iThisWeek - iLastWeek) / iLastWeek * 100);
      if (iPct === 0) { return { direction: "None", label: "no change" }; }
      return {
        direction: iPct > 0 ? "Up" : "Down",
        label: (iPct > 0 ? "▲ " : "▼ ") + Math.abs(iPct) + "% wk"
      };
    },

    /* ---------------------------------------------------------
     * SLA verdict — response clock runs from createdAt until
     * firstResponseAt is stamped; resolution clock runs until
     * completedAt is stamped. Both stamped server-side.
     * `key` is the filterable form of the same verdict.
     * ------------------------------------------------------- */
    _computeSla: function (sPriorityCode, sCreatedAt, sFirstResponseAt, sCompletedAt) {
      var oWindow = SLA_HOURS[sPriorityCode];
      if (!oWindow || !sCreatedAt) { return { state: "None", text: "—", key: "None" }; }

      var HOUR = 3600000;
      var iCreated = new Date(sCreatedAt).getTime();
      var iNow = Date.now();

      if (sCompletedAt) {
        var iResolveBy = iCreated + oWindow.resolution * HOUR;
        return new Date(sCompletedAt).getTime() <= iResolveBy
          ? { state: "Success", text: "SLA Met", key: "Met", deadline: iResolveBy }
          : { state: "Error", text: "SLA Breached", key: "Breached", deadline: iResolveBy };
      }

      if (!sFirstResponseAt) {
        var iResponseBy = iCreated + oWindow.response * HOUR;
        var iLeft = iResponseBy - iNow;
        if (iLeft < 0) { return { state: "Error", text: "Response Overdue", key: "Breached", deadline: iResponseBy }; }
        if (iLeft < oWindow.response * HOUR * 0.25) { return { state: "Warning", text: "Response Due Soon", key: "DueSoon", deadline: iResponseBy }; }
        return { state: "Success", text: "On Track", key: "OnTrack", deadline: iResponseBy };
      }

      var iResolveBy2 = iCreated + oWindow.resolution * HOUR;
      var iLeft2 = iResolveBy2 - iNow;
      if (iLeft2 < 0) { return { state: "Error", text: "Resolution Overdue", key: "Breached", deadline: iResolveBy2 }; }
      if (iLeft2 < oWindow.resolution * HOUR * 0.25) { return { state: "Warning", text: "Due Soon", key: "DueSoon", deadline: iResolveBy2 }; }
      return { state: "Success", text: "On Track", key: "OnTrack", deadline: iResolveBy2 };
    }

  });
});
