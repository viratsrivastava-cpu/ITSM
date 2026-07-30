sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "itsm/ui/util/UserMenu"
], function (Controller, JSONModel, Filter, FilterOperator, UserMenu) {
  "use strict";
 
  // Trend line colors: blue for incoming (created), green for done
  // (resolved) — matches the navy/green semantics already used elsewhere
  // in the app (e.g. the "Confirmed"/"Closed" KPI tile accents).
  var TREND_PALETTE = ["#1d4ed8", "#22c55e"];
 
  var TREND_DAYS_DEFAULT = 14;
 
  // SLA response/resolution windows per priority code, in hours — same
  // table used for the per-ticket SLA badges (Dashboard/Main controllers),
  // rolled up here into met/breached counts instead.
  var SLA_HOURS = {
    P1: { response: 1,   resolution: 4 },
    P2: { response: 4,   resolution: 24 },
    P3: { response: 24,  resolution: 72 },
    P4: { response: 120, resolution: 240 }
  };
 
  var PRIORITY_LABELS = {
    P1: "P1 — Immediate",
    P2: "P2 — Within 4 Hours",
    P3: "P3 — 1 Business Day",
    P4: "P4 — 5 Days"
  };
 
  return Controller.extend("itsm.ui.controller.Analytics", {
 
    onInit: function () {
      this.getView().setModel(new JSONModel({
        trendData: [], stats: {}, slaSummary: { met: 0, breached: 0, byPriority: [] }, atRisk: []
      }), "an");
 
      this._iTrendDays = TREND_DAYS_DEFAULT;
 
      // Data labels on the bars so counts read at a glance even for a
      // single spiky day, instead of needing a hover to see the number.
      // Title off — VizFrame shows a "Title of Chart" placeholder by
      // default when no title text is set; the section pill above it
      // already says what this is.
      this.byId("trendsChart").setVizProperties({
        title: { visible: false },
        plotArea: { colorPalette: TREND_PALETTE, dataLabel: { visible: true } }
      });
 
      this.getOwnerComponent().getRouter()
        .getRoute("analytics")
        .attachPatternMatched(this._onMatched, this);
    },
 
    _onMatched: function () {
      this._loadTrends();
      this._loadStatsAndSla();
      var oBinding = this.byId("sideTicketTable").getBinding("items");
      if (oBinding) { oBinding.refresh(); }
    },
 
    onTrendRangeChange: function (oEvent) {
      this._iTrendDays = parseInt(oEvent.getSource().getSelectedKey(), 10);
      this._loadTrends();
    },
 
    /* ---------------------------------------------------------
     * Tickets created vs resolved, bucketed by day for the selected
     * range. One flat fetch + client-side bucketing beats a day-by-day
     * query for a dataset this size.
     * ------------------------------------------------------- */
    _loadTrends: function () {
      var that = this;
      var oModel = this.getOwnerComponent().getModel();
      var oIncB = oModel.bindList("/Tickets", null, [], [
        new Filter("IsActiveEntity", FilterOperator.EQ, true)
      ], {
        $select: "ID,createdAt,completedAt"
      });
 
      oIncB.requestContexts(0, 9999).then(function (aContexts) {
        var oToday = new Date();
        oToday.setHours(0, 0, 0, 0);
 
        var aBuckets = [];
        var mByKey = {};
        for (var i = that._iTrendDays - 1; i >= 0; i--) {
          var oDate = new Date(oToday.getTime() - i * 86400000);
          var sKey = oDate.toISOString().slice(0, 10);
          var oBucket = {
            date: oDate.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
            created: 0,
            resolved: 0
          };
          aBuckets.push(oBucket);
          mByKey[sKey] = oBucket;
        }
 
        aContexts.forEach(function (oCtx) {
          var sCreated = oCtx.getProperty("createdAt");
          var sResolved = oCtx.getProperty("completedAt");
          if (sCreated && mByKey[sCreated.slice(0, 10)]) { mByKey[sCreated.slice(0, 10)].created++; }
          if (sResolved && mByKey[sResolved.slice(0, 10)]) { mByKey[sResolved.slice(0, 10)].resolved++; }
        });
 
        that.getView().getModel("an").setProperty("/trendData", aBuckets);
      }).catch(function (oErr) {
        // eslint-disable-next-line no-console
        console.error("Analytics trends failed:", oErr);
      });
    },
 
    /* ---------------------------------------------------------
     * Top KPI row + SLA compliance (met vs breached, per priority) + the
     * "At Risk" list (open tickets due soon but not yet breached). One
     * Tickets fetch covers all three — flat fields only, foreign keys
     * mapped to codes via Lookup, same as the dashboard's _loadCounts
     * (nested getProperty("x/code") on an expand isn't reliable in this
     * v4 model).
     * ------------------------------------------------------- */
    _loadStatsAndSla: function () {
      var that = this;
      var oModel = this.getOwnerComponent().getModel();
 
      var oStatusB = oModel.bindList("/LookupValues", null, [], [
        new Filter("lookupType", FilterOperator.EQ, "STATUS")
      ], { $select: "ID,code" });
 
      var oPriB = oModel.bindList("/LookupValues", null, [], [
        new Filter("lookupType", FilterOperator.EQ, "PRIORITY")
      ], { $select: "ID,code" });
 
      var oIncB = oModel.bindList("/Tickets", null, [], [
        new Filter("IsActiveEntity", FilterOperator.EQ, true)
      ], {
        $select: "ID,ticketNumber,shortDescription,status_ID,priority_ID,messageProcessor_ID,createdAt,firstResponseAt,completedAt"
      });
 
      Promise.all([
        oStatusB.requestContexts(0, 999),
        oPriB.requestContexts(0, 999),
        oIncB.requestContexts(0, 9999)
      ]).then(function (aRes) {
        var mStatusCode = {};
        aRes[0].forEach(function (c) { mStatusCode[c.getProperty("ID")] = c.getProperty("code"); });
        var mPriCode = {};
        aRes[1].forEach(function (c) { mPriCode[c.getProperty("ID")] = c.getProperty("code"); });
 
        var aInc = aRes[2];
        var iClosed = 0;
        var iResSum = 0, iResCount = 0;
        var iOldestOpenAge = null;
        var iUnassigned = 0;
        var aAtRisk = [];
 
        var mByPriority = {};
        Object.keys(SLA_HOURS).forEach(function (c) { mByPriority[c] = { met: 0, breached: 0 }; });
 
        // "Vs last week" for the count-type tiles (At Risk/Breached/
        // Unassigned) — bucketed purely by createdAt, the only thing we
        // have real history for. Doesn't apply to Compliance %/Oldest
        // Open/Avg Resolution, which aren't simple counts.
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
          if (!sBucket) { return; }
          if (sBucket === "this") { oMap[sKey].thisWeek++; }
          else { oMap[sKey].lastWeek++; }
        }
        var mMetricWeek = { unassigned: { thisWeek: 0, lastWeek: 0 }, breached: { thisWeek: 0, lastWeek: 0 }, atRisk: { thisWeek: 0, lastWeek: 0 } };
 
        aInc.forEach(function (oCtx) {
          var sStatusId = oCtx.getProperty("status_ID");
          if (mStatusCode[sStatusId] === "CLOSED") { iClosed++; }
 
          var sCreated = oCtx.getProperty("createdAt");
          var sBucket = weekBucket(sCreated);
 
          if (!oCtx.getProperty("messageProcessor_ID")) {
            iUnassigned++;
            bump(mMetricWeek, "unassigned", sBucket);
          }
 
          var sCompleted = oCtx.getProperty("completedAt");
          if (sCreated && sCompleted) {
            iResSum += (new Date(sCompleted).getTime() - new Date(sCreated).getTime());
            iResCount++;
          }
 
          if (!sCompleted && sCreated) {
            var iAge = Date.now() - new Date(sCreated).getTime();
            if (iOldestOpenAge === null || iAge > iOldestOpenAge) { iOldestOpenAge = iAge; }
          }
 
          var sPriId = oCtx.getProperty("priority_ID");
          var sCode = sPriId && mPriCode[sPriId];
          if (sCode && mByPriority[sCode]) {
            var sFirstResponse = oCtx.getProperty("firstResponseAt");
            var oResult = that._computeSlaDetail(sCode, sCreated, sFirstResponse, sCompleted);
            if (oResult.state === "Error") {
              mByPriority[sCode].breached++;
              bump(mMetricWeek, "breached", sBucket);
            } else {
              mByPriority[sCode].met++;
            }
 
            if (!sCompleted && oResult.state === "Warning") {
              bump(mMetricWeek, "atRisk", sBucket);
              aAtRisk.push({
                ID: oCtx.getProperty("ID"),
                ticketNumber: oCtx.getProperty("ticketNumber"),
                shortDescription: oCtx.getProperty("shortDescription"),
                priority: sCode,
                deadline: oResult.deadline,
                dueText: that._formatTimeLeft(oResult.deadline - Date.now())
              });
            }
          }
        });
 
        aAtRisk.sort(function (a, b) { return a.deadline - b.deadline; });
 
        var iMetTotal = 0, iBreachedTotal = 0;
        var aByPriority = Object.keys(SLA_HOURS).map(function (sCode) {
          var o = mByPriority[sCode];
          iMetTotal += o.met;
          iBreachedTotal += o.breached;
          var iRowTotal = o.met + o.breached;
          return {
            label: PRIORITY_LABELS[sCode],
            met: o.met,
            breached: o.breached,
            percent: iRowTotal ? Math.round((o.met / iRowTotal) * 100) : 0,
            state: o.breached === 0 ? "Success" : (o.breached >= o.met ? "Error" : "Warning")
          };
        });
 
        var oAn = that.getView().getModel("an");
        oAn.setProperty("/stats", {
          atRisk: aAtRisk.length,
          breached: iBreachedTotal,
          compliancePercent: (iMetTotal + iBreachedTotal) ? Math.round((iMetTotal / (iMetTotal + iBreachedTotal)) * 100) : 100,
          oldestOpenAge: iOldestOpenAge === null ? "—" : that._formatDuration(iOldestOpenAge),
          avgResolution: iResCount ? that._formatDuration(iResSum / iResCount) : "—",
          unassigned: iUnassigned
        });
        oAn.setProperty("/slaSummary", { met: iMetTotal, breached: iBreachedTotal, byPriority: aByPriority });
        oAn.setProperty("/atRisk", aAtRisk);
 
        that._setTrendBadge("atRiskBadge", that._formatTrend(mMetricWeek.atRisk.thisWeek, mMetricWeek.atRisk.lastWeek));
        that._setTrendBadge("breachedBadge", that._formatTrend(mMetricWeek.breached.thisWeek, mMetricWeek.breached.lastWeek));
        that._setTrendBadge("unassignedBadge", that._formatTrend(mMetricWeek.unassigned.thisWeek, mMetricWeek.unassigned.lastWeek));
      }).catch(function (oErr) {
        // eslint-disable-next-line no-console
        console.error("Analytics stats/SLA failed:", oErr);
      });
    },
 
    _formatDuration: function (iMs) {
      var iHours = iMs / 3600000;
      if (iHours < 24) { return iHours.toFixed(1) + "h"; }
      return (iHours / 24).toFixed(1) + "d";
    },
 
    // A small custom badge (plain Unicode arrows, not the SAP icon font —
    // no glyph-name guessing, full control over size/weight/color) instead
    // of GenericTile's own footer/indicator, which either don't render in
    // this compact frame type or don't look right. "This week" with
    // nothing to compare against (no matching tickets 7-14 days ago) reads
    // as "+N new" rather than a divide-by-zero percentage.
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
 
    _setTrendBadge: function (sId, oTrend) {
      var oBadge = this.byId(sId);
      if (!oBadge) { return; }
      oBadge.setText(oTrend.label);
      oBadge.toggleStyleClass("trendUp", oTrend.direction === "Up");
      oBadge.toggleStyleClass("trendDown", oTrend.direction === "Down");
    },
 
    _formatTimeLeft: function (iMs) {
      if (iMs <= 0) { return "Overdue"; }
      var iMinutes = iMs / 60000;
      if (iMinutes < 60) { return Math.round(iMinutes) + "m left"; }
      var iHours = iMs / 3600000;
      if (iHours < 24) { return iHours.toFixed(1) + "h left"; }
      return (iHours / 24).toFixed(1) + "d left";
    },
 
    /* ---------------------------------------------------------
     * Collapse/expand the tickets card — same behavior as the dashboard's
     * chart card toggle.
     * ------------------------------------------------------- */
    onToggleTiles: function () {
      this._bTilesCollapsed = !this._bTilesCollapsed;
      this.byId("tilesPane").toggleStyleClass("chartCollapsed", this._bTilesCollapsed);
 
      var oBtn = this.byId("tilesToggleBtn");
      oBtn.setIcon(this._bTilesCollapsed ? "sap-icon://slim-arrow-left" : "sap-icon://slim-arrow-right");
      oBtn.setTooltip(this._bTilesCollapsed ? "Expand" : "Collapse");
    },
 
    onGoDashboard: function () {
      this.getOwnerComponent().getRouter().navTo("dashboard");
    },

    onProfilePress: function (oEvent) {
      UserMenu.open(oEvent.getSource(), this.getOwnerComponent());
    },
 
    onTicketPress: function (oEvent) {
      var oItem = oEvent.getParameter("listItem") || oEvent.getSource();
      var oCtx = oItem.getBindingContext();
      if (oCtx) {
        this.getOwnerComponent().getRouter().navTo("detail", { id: oCtx.getProperty("ID") });
      }
    },
 
    onAtRiskPress: function (oEvent) {
      var oCtx = oEvent.getSource().getBindingContext("an");
      if (oCtx) {
        this.getOwnerComponent().getRouter().navTo("detail", { id: oCtx.getProperty("ID") });
      }
    },
 
    // OData v4 delivers timestamps as ISO strings; format them for display.
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
 
    formatSlaState: function (sPriorityCode, sCreatedAt, sFirstResponseAt, sCompletedAt) {
      return this._computeSlaDetail(sPriorityCode, sCreatedAt, sFirstResponseAt, sCompletedAt).state;
    },
 
    formatSlaText: function (sPriorityCode, sCreatedAt, sFirstResponseAt, sCompletedAt) {
      return this._computeSlaDetail(sPriorityCode, sCreatedAt, sFirstResponseAt, sCompletedAt).text;
    },
 
    // Same response/resolution-window logic as the per-ticket SLA badges
    // on the dashboard/Main controllers — used both for the ticket table's
    // SLA column here and (state only) for the compliance summary above.
    _computeSlaDetail: function (sPriorityCode, sCreatedAt, sFirstResponseAt, sCompletedAt) {
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
        if (iLeft < 0) { return { state: "Error", text: "Response Overdue", deadline: iResponseBy }; }
        if (iLeft < oWindow.response * HOUR * 0.25) { return { state: "Warning", text: "Response Due Soon", deadline: iResponseBy }; }
        return { state: "Success", text: "On Track", deadline: iResponseBy };
      }
 
      var iResolveBy2 = iCreated + oWindow.resolution * HOUR;
      var iLeft2 = iResolveBy2 - iNow;
      if (iLeft2 < 0) { return { state: "Error", text: "Resolution Overdue", deadline: iResolveBy2 }; }
      if (iLeft2 < oWindow.resolution * HOUR * 0.25) { return { state: "Warning", text: "Due Soon", deadline: iResolveBy2 }; }
      return { state: "Success", text: "On Track", deadline: iResolveBy2 };
    }
 
  });
});
 
 