sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/ui/model/Sorter",
  "sap/m/MessageToast",
  "sap/m/MessageBox",
  "itsm/ui/util/UserMenu",
  "itsm/ui/util/Lookups"
], function (Controller, JSONModel, Filter, FilterOperator, Sorter, MessageToast, MessageBox, UserMenu, Lookups) {
  "use strict";

  // Root of the category tree. Everything below it is discovered via parent_ID,
  // so new levels/values are added in master data, not here.
  var CAT_ROOT_TYPE = "CATEGORY1";
  var CAT_PAGE_SIZE = 500;

  // SLA response/resolution windows per priority code, in hours. Matches
  // (loosely) the descriptions in the PRIORITY lookup master data —
  // P1 "Immediate", P2 "within 4 hours", P3 "1 business day", P4 "5 days".
  var SLA_HOURS = {
    P1: { response: 1,   resolution: 4 },
    P2: { response: 4,   resolution: 24 },
    P3: { response: 24,  resolution: 72 },
    P4: { response: 120, resolution: 240 }
  };

  // Human labels for TicketHistory.fieldName — must match the field names
  // srv/handlers/audit.js writes (TRACKED_FIELDS there, minus the _ID suffix).
  var FIELD_LABELS = {
    ticketType: "Ticket Type", shortDescription: "Short Description", description: "Description",
    reportedBy: "Reported By", messageProcessor: "Assigned To", supportTeam: "Support Team",
    category1: "Category 1", category2: "Category 2", category3: "Category 3", category4: "Category 4",
    solutionCategory: "Solution Category", status: "Status", impact: "Impact", urgency: "Urgency",
    priority: "Priority", recommendedPriority: "Recommended Priority", language: "Language",
    isStandard: "Standard Ticket", system: "System", softwareComponent: "Software Component",
    softwareVersion: "Software Version", supportPackage: "Support Package",
    configurationItem: "Configuration Item", relatedRFC: "Related RFC",
    firstResponseAt: "First Response", dueAt: "Due Date", completedAt: "Completed On",
    irtStatus: "IRT Status", mptStatus: "MPT Status"
  };


  // The incident-specific half of a ticket. Since the entity split these
  // live on IncidentForm, a separate entity reached through the
  // `incidentForm` composition. They are edited through a plain JSON model
  // rather than bound to `incidentForm/...` on the OData context, because
  // a brand-new ticket has no form row yet — there would be nothing for
  // those bindings to resolve against until after the first save.
  var FORM_FIELDS = [
    "description", "category1", "category2", "category3", "category4",
    "solutionCategory", "impact", "urgency", "recommendedPriority",
    "language", "isStandard", "system_ID", "softwareComponent_ID",
    "softwareVersion", "supportPackage", "configurationItem_ID",
    "relatedRFC", "irtStatus", "mptStatus"
  ];

  function emptyForm() {
    var o = {};
    FORM_FIELDS.forEach(function (f) { o[f] = null; });
    o.isStandard = false;
    return o;
  }

  return Controller.extend("itsm.ui.controller.Main", {

    /* ---------------------------------------------------------
     * Lifecycle
     * ------------------------------------------------------- */
    onInit: function () {
      // Local model for pending attachments (before the ticket is saved)
      this.getView().setModel(new JSONModel({ list: [] }), "attachments");

      // Change-history timeline (empty until an existing ticket is loaded).
      this.getView().setModel(new JSONModel({ list: [] }), "hist");

      // Drives header buttons and form editability by mode.
      this.getView().setModel(new JSONModel({}), "ui");

      // The IncidentForm half of the ticket (see FORM_FIELDS above).
      this.getView().setModel(new JSONModel(emptyForm()), "form");

      // The form is shared by two routes: "create" (new draft) and
      // "detail" (view an existing ticket). The view is cached and reused, so
      // the per-visit setup lives in the route-matched handlers, not onInit.
      var oRouter = this.getOwnerComponent().getRouter();
      oRouter.getRoute("create").attachPatternMatched(this._onCreateMatched, this);
      oRouter.getRoute("detail").attachPatternMatched(this._onDetailMatched, this);
    },

    /**
     * Switch the form between "create", "view" and "edit". Everything the
     * header and fields react to lives in the "ui" model, so the view stays
     * declarative. The header title itself is a fixed app name (see the
     * view); "ticketLabel" carries the ticket-specific id/placeholder that
     * shows below it instead.
     */
    _setMode: function (sMode) {
      this._sMode = sMode;
      var sNumber = this._oTicketContext
        ? this._oTicketContext.getProperty("ticketNumber")
        : null;

      var mModes = {
        create: {
          ticketLabel: "New Ticket",
          subtitle: "Creating New Service Request Record",
          formEditable: true,
          // Two-phase create: Save first (which assigns the number and puts
          // the ticket in DRAFT), and only then can it be submitted.
          showBack: true, showEdit: false, showSave: true, showSubmit: false
        },
        // Saved and activated, but still DRAFT — the only state in which
        // a submit is allowed (before-SAVE rejects it in any other).
        draftSaved: {
          ticketLabel: sNumber || "Ticket",
          subtitle: "Saved as draft — not yet submitted",
          formEditable: false,
          showBack: true, showEdit: true, showSave: false, showSubmit: true
        },
        view: {
          ticketLabel: sNumber || "Ticket",
          subtitle: "Viewing service request",
          formEditable: false,
          showBack: true, showEdit: true, showSave: false, showSubmit: false
        },
        edit: {
          ticketLabel: sNumber || "Ticket",
          subtitle: "Editing service request",
          formEditable: true,
          showBack: true, showEdit: false, showSave: true, showSubmit: false
        }
      };
      this.getView().getModel("ui").setData(mModes[sMode]);
      this._syncFormFade(mModes[sMode].formEditable);
    },

    /* ---------------------------------------------------------
     * View mode: fields are already read-only, but fade the whole form
     * too so it visibly reads as "look, don't touch" until Edit is
     * pressed — full opacity/interactive again the moment it is.
     * Binding a "class" directly (plain or expression syntax) silently
     * fails to resolve in this UI5 build, so it's toggled here instead.
     * ------------------------------------------------------- */
    _syncFormFade: function (bEditable) {
      var bFaded = !bEditable;
      ["secDetails", "secDescription", "secAttachments"].forEach(function (sId) {
        var oSection = this.byId(sId);
        if (oSection) { oSection.toggleStyleClass("formFaded", bFaded); }
      }, this);
    },

    /* ---------------------------------------------------------
     * Route: create — fresh draft each time.
     * ------------------------------------------------------- */
    _onCreateMatched: function () {
      this._resetPendingAttachments();
      this.getView().getModel("hist").setProperty("/list", []);
      this.getView().getModel("ui").setProperty("/ticketNumberPreview", null);
      this.getView().getModel("form").setData(emptyForm());
      this._createNewTicket();
      this._setMode("create");
      this._setupCategories();
      this._previewTicketNumber();
      this._scrollToTop();
    },

    /* ---------------------------------------------------------
     * Route: detail — bind an existing ticket, read-only to start.
     * ------------------------------------------------------- */
    _onDetailMatched: function (oEvent) {
      var sId = oEvent.getParameter("arguments").id;
      this._resetPendingAttachments();
      this.getView().getModel("ui").setProperty("/ticketNumberPreview", null);
      this._bindExistingTicket(sId);
      // Start read-only, then reveal Submit if this ticket is still a saved
      // DRAFT — reopening one from the dashboard must offer the same next
      // step as having just saved it.
      this._setMode("view");
      if (this._oTicketContext) { this._setModeFromStatus(this._oTicketContext); }
      this._setupCategories();
      this._loadHistory(sId);
      this._scrollToTop();
    },

    /* ---------------------------------------------------------
     * The router moves focus into the new view for accessibility,
     * which the browser answers by scrolling the focused control
     * into view — clipping the header at the top of the page. Pin
     * the scroll position back to the top on every navigation here.
     * ------------------------------------------------------- */
    _scrollToTop: function () {
      var oPage = this.byId("page");
      setTimeout(function () { oPage.scrollTo(0, 0, 0); }, 0);
    },

    /* ---------------------------------------------------------
     * Change-history timeline — who changed what, and when.
     * Populated from TicketHistory rows srv/handlers/audit.js writes on
     * every field it detects changed when a ticket is SAVEd. There is no
     * row for the initial creation — history records changes, not the
     * starting values — so a brand-new ticket legitimately shows nothing.
     * ------------------------------------------------------- */
    _loadHistory: function (sId) {
      var that = this;
      var oModel = this.getOwnerComponent().getModel();
      var oBinding = oModel.bindList(
        "/TicketHistory",
        null,
        [new Sorter("createdAt", true)],
        [new Filter("ticket_ticketID", FilterOperator.EQ, sId)],
        { $expand: "changedBy($select=name)" }
      );

      Promise.all([
        oBinding.requestContexts(0, 200),
        this._loadLabelMap()
      ]).then(function (aRes) {
        var aList = aRes[0].map(function (oCtx) { return oCtx.getObject(); });
        that.getView().getModel("hist").setProperty("/list", aList);
      }).catch(function () {
        // History is supplementary — a failed load shouldn't block the page.
      });
    },

    /* ---------------------------------------------------------
     * TicketHistory.oldValue/newValue store raw association IDs (e.g. a
     * LookupValue or User key), not display text. Build one ID->name map
     * across every master entity a tracked field can point to, so the
     * timeline can show "Confirmed" instead of a GUID. Loaded once and
     * cached — this is reference data, it doesn't change mid-session.
     * ------------------------------------------------------- */
    _loadLabelMap: function () {
      if (this._mLabels) { return Promise.resolve(this._mLabels); }

      var oModel = this.getOwnerComponent().getModel();
      function loadMap(sPath) {
        return oModel.bindList(sPath, null, [], [], { $select: "ID,name" })
          .requestContexts(0, 5000)
          .then(function (aCtx) {
            var m = {};
            aCtx.forEach(function (c) { m[c.getProperty("ID")] = c.getProperty("name"); });
            return m;
          });
      }

      var that = this;
      return Promise.all([
        loadMap("/LookupValues"),
        loadMap("/Users"),
        loadMap("/Systems"),
        loadMap("/SoftwareComponents"),
        loadMap("/ConfigurationItems")
      ]).then(function (aMaps) {
        that._mLabels = Object.assign.apply(Object, [{}].concat(aMaps));
        return that._mLabels;
      });
    },

    /* ---------------------------------------------------------
     * Edit / Back
     * ------------------------------------------------------- */
    onEdit: function () {
      // No draft round-trip any more: the ticket is a plain row, so editing
      // is just unlocking the form. Changes are queued in the deferred
      // "itsmGroup" batch and sent as one PATCH by onSave.
      this._setMode("edit");
    },

    onBack: function () {
      this.onGoDashboard();
    },

    // "Home" is role-dependent: a Service Group user must never be sent to
    // the end-user dashboard, so the destination comes from the component's
    // route policy rather than being hard-coded here.
    onGoDashboard: function () {
      this.getOwnerComponent().navToHome();
    },

    // The view shows the recommended priority as a name; the column holds
    // the code since the entity split.
    formatPriorityName: function (sCode) { return Lookups.name("PRIORITY", sCode); },

    onProfilePress: function (oEvent) {
      UserMenu.open(oEvent.getSource(), this.getOwnerComponent());
    },

    /* ---------------------------------------------------------
     * Ask the backend for the next number and show it read-only. This is
     * display-only — it goes into the "ui" model, never into the ticket's
     * own ticketNumber field. Writing it into the real field would let the
     * backend's first-activation stamping (srv/handlers/tickets.js)
     * skip re-computing on SAVE, so two tickets created around the same
     * time could both activate with the same previewed number.
     * ------------------------------------------------------- */
    _previewTicketNumber: function () {
      var that = this;
      var oModel = this.getOwnerComponent().getModel();
      var oCtx = oModel.bindContext("/nextTicketNumber(...)");
      oCtx.execute().then(function () {
        var sNext = oCtx.getBoundContext().getProperty("value");
        if (sNext) {
          that.getView().getModel("ui").setProperty("/ticketNumberPreview", sNext);
        }
      }).catch(function () {
        /* preview only — ignore, backend still assigns on save */
      });
    },

    formatTicketNumberDisplay: function (sReal, sPreview) {
      return sReal || sPreview || "";
    },

    // A plain row addressed by its key — no draft variant to disambiguate.
    _bindExistingTicket: function (sId) {
      var that = this;
      var oModel = this.getOwnerComponent().getModel();
      // No manual $expand here: the model runs with autoExpandSelect, which
      // builds its own $expand/$select and rejects a hand-written one. The
      // form is fetched as its own request instead.
      var oCtx = oModel.bindContext(
        "/Tickets('" + sId + "')",
        null,
        { $$updateGroupId: "itsmGroup" }
      ).getBoundContext();
      this._oTicketContext = oCtx;
      this.getView().setBindingContext(oCtx);

      // Copy the form half into its own model so the fields bound to
      // form>/... show the stored values.
      this.getView().getModel("form").setData(emptyForm());
      this._sFormId = null;

      oModel.bindList("/IncidentForms", null, [], [
        new Filter("ticket_ticketID", FilterOperator.EQ, sId)
      ]).requestContexts(0, 1).then(function (aCtx) {
        if (!aCtx.length) { return; }
        var oForm = aCtx[0].getObject();
        that._sFormId = oForm.ID;
        var oData = emptyForm();
        FORM_FIELDS.forEach(function (f) {
          if (oForm[f] !== undefined) { oData[f] = oForm[f]; }
        });
        that.getView().getModel("form").setData(oData);
      }).catch(function () { that._sFormId = null; });
    },

    /* ---------------------------------------------------------
     * Tabs are in-page navigation — scroll to the matching section
     * instead of swapping content.
     * ------------------------------------------------------- */
    onTabSelect: function (oEvent) {
      var mSections = {
        details: "secDetails",
        description: "secDescription",
        attachments: "secAttachments",
        history: "secHistory"
      };
      var oSection = this.byId(mSections[oEvent.getParameter("key")]);
      if (oSection) {
        this.byId("page").scrollToElement(oSection.getDomRef(), 400);
      }
    },

    /* =========================================================
     * CASCADING CATEGORIES
     *
     * The hierarchy lives entirely in LookupValue.parent_ID. This
     * controller never hardcodes which values belong to which
     * parent — it only ever asks the service for "children of X".
     *
     * Depth is discovered by probing for selCategory1..N controls,
     * so adding a 5th level means adding a 5th Select to the view;
     * no logic here changes.
     * ======================================================= */

    _setupCategories: function () {
      // Discover how many category levels the view declares.
      this._aCatLevels = [];
      for (var i = 1; this.byId("selCategory" + i); i++) {
        this._aCatLevels.push("selCategory" + i);
      }

      // Children are fetched one level at a time and cached by parent id,
      // so the full tree is never loaded and repeat visits cost no requests.
      this._mCatCache = {};

      var aLevels = this._aCatLevels.map(function () {
        return { items: [], enabled: false, busy: false, noChildren: false };
      });
      this.getView().setModel(new JSONModel({ levels: aLevels }), "cat");

      // Level 1 = roots; deeper levels populate from the current record (edit
      // case) or stay disabled until a parent is picked (create case).
      this._loadLevel(0, null).then(this._restoreCategoryChain.bind(this));
    },

    /**
     * Fetch the children of a parent (or the roots when sParentId is null).
     * Cached per parent id.
     */
    _fetchChildren: function (sParentId) {
      var sKey = sParentId || "__root__";
      if (this._mCatCache[sKey]) {
        return Promise.resolve(this._mCatCache[sKey]);
      }

      var aFilters = [new Filter("isActive", FilterOperator.EQ, true)];
      if (sParentId) {
        // The selected value is the parent's NAME now (categories store
        // names since the entity split), so the tree is walked through the
        // association rather than by id.
        aFilters.push(new Filter("parent/name", FilterOperator.EQ, sParentId));
      } else {
        aFilters.push(new Filter("lookupType", FilterOperator.EQ, CAT_ROOT_TYPE));
      }

      var oBinding = this.getOwnerComponent().getModel().bindList(
        "/LookupValues", null, [new Sorter("sequence")], aFilters
      );

      var that = this;
      return oBinding.requestContexts(0, CAT_PAGE_SIZE).then(function (aContexts) {
        var aItems = aContexts.map(function (oCtx) {
          return { ID: oCtx.getProperty("ID"), name: oCtx.getProperty("name") };
        });
        that._mCatCache[sKey] = aItems;
        return aItems;
      });
    },

    /**
     * Populate one level with the children of sParentId.
     */
    _loadLevel: function (iLevel, sParentId) {
      if (iLevel >= this._aCatLevels.length) { return Promise.resolve([]); }

      var oCat = this.getView().getModel("cat");
      var sPath = "/levels/" + iLevel + "/";
      oCat.setProperty(sPath + "busy", true);

      var that = this;
      return this._fetchChildren(sParentId).then(function (aItems) {
        oCat.setProperty(sPath + "items", aItems);
        oCat.setProperty(sPath + "enabled", aItems.length > 0);
        // Only tell the user a branch is a dead end once they've chosen a parent.
        oCat.setProperty(sPath + "noChildren", aItems.length === 0 && !!sParentId);
        oCat.setProperty(sPath + "busy", false);
        return aItems;
      }).catch(function (oErr) {
        oCat.setProperty(sPath + "busy", false);
        MessageBox.error("Could not load categories: " + (oErr.message || oErr));
        return [];
      });
    },

    /**
     * Clear every level from iFrom downwards, in both the UI model and the
     * ticket record.
     */
    _clearLevelsFrom: function (iFrom) {
      var oCat = this.getView().getModel("cat");
      for (var i = iFrom; i < this._aCatLevels.length; i++) {
        oCat.setProperty("/levels/" + i + "/items", []);
        oCat.setProperty("/levels/" + i + "/enabled", false);
        oCat.setProperty("/levels/" + i + "/noChildren", false);
        oCat.setProperty("/levels/" + i + "/busy", false);
        this._setCategoryValue(i, null);
      }
    },

    // Categories moved to IncidentForm in the entity split and store the
    // category NAME, not a LookupValue id — so the cascade reads and writes
    // the "form" model rather than the ticket context.
    _setCategoryValue: function (iLevel, sValue) {
      this.getView().getModel("form").setProperty("/category" + (iLevel + 1), sValue);
    },

    _getCategoryValue: function (iLevel) {
      return this.getView().getModel("form").getProperty("/category" + (iLevel + 1));
    },

    /**
     * A parent changed: drop every selection below it, then load the next level.
     */
    onCategoryChange: function (oEvent) {
      var sLocalId = oEvent.getSource().getId().split("--").pop();
      var iLevel = this._aCatLevels.indexOf(sLocalId);
      if (iLevel === -1) { return; }

      var sKey = oEvent.getSource().getSelectedKey();

      // Resetting first guarantees a stale grandchild can never survive.
      this._clearLevelsFrom(iLevel + 1);
      this._setCategoryValue(iLevel, sKey || null);

      if (sKey) {
        this._loadLevel(iLevel + 1, sKey);
      }
    },

    /**
     * Editing an existing record: walk down the saved chain so each level has
     * its options loaded and the stored selections survive.
     */
    _restoreCategoryChain: function () {
      var that = this;
      var iLevel = 0;

      function step() {
        var sValue = that._getCategoryValue(iLevel);
        if (!sValue || iLevel + 1 >= that._aCatLevels.length) {
          return Promise.resolve();
        }
        return that._loadLevel(iLevel + 1, sValue).then(function () {
          iLevel++;
          return step();
        });
      }

      return step();
    },

    /* ---------------------------------------------------------
     * Create a transient (pending) OData v4 context. Nothing is sent
     * until onSave submits the deferred "itsmGroup" batch, so navigating
     * away simply abandons it and no half-filled ticket ever reaches the
     * database.
     * ------------------------------------------------------- */
    _createNewTicket: function () {
      // Models propagate from the component; the view is not yet attached
      // to the control tree during onInit, so getView().getModel() is undefined here.
      var oModel = this.getOwnerComponent().getModel();
      var oListBinding = oModel.bindList("/Tickets", null, [], [], {
        $$updateGroupId: "itsmGroup"
      });

      // create() returns a transient context — nothing sent to server yet
      // Transient until Save: create() queues a POST in the deferred
      // "itsmGroup" batch and nothing reaches the server until submitBatch.
      // Status is deliberately not set here — before('CREATE') forces DRAFT
      // server-side, so the client cannot put a new ticket anywhere else.
      this._oTicketContext = oListBinding.create({
        priority: null
      }, true /* bSkipRefresh */);

      // Bind the whole page to this transient context
      this.getView().setBindingContext(this._oTicketContext);
    },

    /* ---------------------------------------------------------
     * SAVE — queue pending attachments as nested creates under the draft,
     * flush everything into the draft, then activate it into the real
     * Tickets row. Activation is also where the backend assigns the
     * ticket number and writes the audit history (srv/handlers/tickets.js
     * and audit.js both hook the SAVE event) — submitBatch alone would
     * leave the ticket stuck as an invisible draft forever, with no
     * number and no audit trail.
     *
     * Attachments must go in *before* activation, not after: Attachments
     * is a composition child of the draft-enabled Ticket, and CAP rejects
     * direct writes to a draft-enabled entity's children outside its own
     * draft tree ("A draft-enabled entity can only be modified via its
     * root entity") — even though Attachments is also separately exposed
     * as its own top-level entity set.
     * ------------------------------------------------------- */
    onSave: function () {
      var that = this;
      var oModel = this.getView().getModel();

      var oData = this._oTicketContext.getObject();
      if (!oData.shortDescription) {
        MessageBox.warning("Short Description is required.");
        return;
      }

      var bCreating = this._sMode === "create";
      var oForm = this.getView().getModel("form").getData();

      // The form half travels with the ticket as a deep insert on create,
      // and as its own PATCH on edit — one round-trip either way.
      if (bCreating) {
        this._oTicketContext.setProperty("incidentForm", oForm);
      }

      // Plain CRUD. In create mode the queued transient context becomes one
      // POST; in edit mode the changed fields become one PATCH. Either way
      // the record is in the database when this resolves — before('CREATE')
      // has stamped the number and DRAFT status, and no separate activation
      // step exists any more.
      oModel.submitBatch("itsmGroup").then(function () {
        return that._oTicketContext.created
          ? that._oTicketContext.created()
          : Promise.resolve();
      }).then(function () {
        // On edit the form is a separate row, so it needs its own update.
        if (bCreating || !that._sFormId) { return Promise.resolve(); }
        return oModel.bindContext("/IncidentForms(" + that._sFormId + ")", null,
          { $$updateGroupId: "$auto" }).getBoundContext().requestObject().then(function () {
            var oCtx = oModel.bindContext("/IncidentForms(" + that._sFormId + ")", null,
              { $$updateGroupId: "$auto" }).getBoundContext();
            return Promise.all(FORM_FIELDS.map(function (f) {
              return oCtx.setProperty(f, oForm[f], "$auto");
            }));
          });
      }).then(function () {
        // Attachments are a composition, so they can only be posted once
        // the parent has a real key.
        if (!that._hasPendingAttachments()) { return Promise.resolve(); }
        that._queuePendingAttachments();
        return oModel.submitBatch("itsmGroup");
      }).then(function () {
        var sNumber = that._oTicketContext.getProperty("ticketNumber");
        that._resetPendingAttachments();
        MessageToast.show("Ticket " + sNumber + (bCreating ? " saved as draft." : " updated."));

        // Stay on the page: the number has just appeared, and Submit is the
        // next step of the two-phase flow.
        that._setModeFromStatus(that._oTicketContext);
      }).catch(function (err) {
        MessageBox.error("Save failed: " + (err.message || err));
      });
    },

    _hasPendingAttachments: function () {
      var aList = this.getView().getModel("attachments").getProperty("/list") || [];
      return aList.length > 0;
    },

    /* ---------------------------------------------------------
     * After a save (or when opening an existing ticket) decide
     * whether Submit applies: it does only while the ticket is
     * still in DRAFT status, which is also what the server
     * enforces in before('SAVE').
     * ------------------------------------------------------- */
    _setModeFromStatus: function (oCtx) {
      var that = this;
      // requestProperty, not getProperty: on a freshly bound detail context
      // the data has not arrived yet, so getProperty returns undefined and
      // every DRAFT ticket would silently fall through to read-only "view"
      // with no Submit button. status is the code itself now, so no
      // LookupValue round-trip is needed to compare it.
      oCtx.requestProperty("status").then(function (sStatus) {
        that._setMode(sStatus === "DRAFT" ? "draftSaved" : "view");
      }).catch(function () {
        /* leave whatever mode was already set */
      });
    },



    /* ---------------------------------------------------------
     * SUBMIT — same as save but also validates required fields
     * ------------------------------------------------------- */
    onSubmit: function () {
      var that = this;
      var oData = this._oTicketContext.getObject();

      var aMissing = [];
      if (!oData.shortDescription)  aMissing.push("Short Description");
      var oForm = this.getView().getModel("form").getData();
      if (!oForm.impact)            aMissing.push("Impact");
      if (!oForm.urgency)           aMissing.push("Urgency");
      if (!oData.priority)          aMissing.push("Final Priority");
      if (!oForm.description)       aMissing.push("Full Description");

      if (aMissing.length) {
        MessageBox.warning("Please fill in: " + aMissing.join(", "));
        return;
      }

      // Submit is one PATCH of the status. before('UPDATE') checks the
      // transition is legal and that the caller is the reporter;
      // after('UPDATE') writes the history row. No custom action, and no
      // second code path that could drift from an ordinary edit.
      var sNumber = this._oTicketContext.getProperty("ticketNumber");

      // status holds the code itself now, so there is nothing to resolve.
      // Third argument is the group id: the context's own group is the
      // deferred "itsmGroup", whose promise would not settle until
      // something submitted that batch. "$auto" sends it immediately.
      this._oTicketContext.setProperty("status", "SUBMITTED", "$auto")
      .then(function () {
        MessageToast.show("Ticket " + sNumber + " submitted.");
        that.getOwnerComponent().navToHome();
      }).catch(function (err) {
        MessageBox.error("Submit failed: " + (err.message || err));
      });
    },


    // A STATUS lookup id by code, fetched once per code and remembered.
    _requestStatusId: function (sCode) {
      this._mStatusIds = this._mStatusIds || {};
      if (this._mStatusIds[sCode]) { return this._mStatusIds[sCode]; }

      var oBinding = this.getOwnerComponent().getModel().bindList("/LookupValues", null, [], [
        new Filter("lookupType", FilterOperator.EQ, "STATUS"),
        new Filter("code", FilterOperator.EQ, sCode)
      ], { $select: "ID" });

      this._mStatusIds[sCode] = oBinding.requestContexts(0, 1).then(function (aCtx) {
        return aCtx.length ? aCtx[0].getProperty("ID") : null;
      });

      return this._mStatusIds[sCode];
    },

    /* ---------------------------------------------------------
     * UploadSet handlers — instantUpload="false". A newly picked file is
     * always inserted by the control itself into its own "incompleteItems"
     * aggregation and shown there automatically; that happens unconditionally,
     * regardless of whether the "items" aggregation is bound to anything.
     * The "attachments" JSONModel here is *not* bound to the control's
     * items — it's just our own bookkeeping list (fileName/size/etc.) that
     * onSave reads to create the real Attachment records. Binding it to
     * UploadSet's "items" aggregation as well used to make every picked
     * file render twice: once as the control's own incomplete item, once
     * again from the model-driven item template.
     * ------------------------------------------------------- */
    // Clears both our own bookkeeping list and the control's own queued
    // (incomplete) items — needed on every fresh create/detail visit since
    // the view is cached and reused, and again right after a successful
    // save once the queued files have become real, persisted attachments.
    _resetPendingAttachments: function () {
      this.getView().getModel("attachments").setProperty("/list", []);
      var oUploadSet = this.byId("attachmentUploadSet");
      if (oUploadSet) { oUploadSet.removeAllAggregation("incompleteItems"); }
    },

    onAttachmentAdded: function (oEvent) {
      var oItem = oEvent.getParameter("item");
      if (!oItem) { return; }

      // No item template exists anymore (see above), so the per-item
      // "open" behavior is wired directly on the item instance here.
      oItem.attachOpenPressed(this.onAttachmentDownload, this);

      var oFile = oItem.getFileObject();
      var oAttModel = this.getView().getModel("attachments");
      var aList = oAttModel.getProperty("/list");

      aList.push({
        fileName: oItem.getFileName(),
        originalName: oItem.getFileName(),
        mimeType: oFile ? oFile.type : "",
        fileSize: oFile ? oFile.size : 0,
        _fileObject: oFile,           // kept only in memory
        _uploadSetItem: oItem         // links this entry back to the control's own item, for removal
      });

      oAttModel.setProperty("/list", aList);
      MessageToast.show("1 file queued");
    },

    // Fired once the user confirms removal in UploadSet's own built-in
    // delete dialog. Since "items" isn't bound, the control removes the
    // item from its own incompleteItems aggregation by itself — this only
    // needs to drop the matching bookkeeping entry so it isn't saved.
    onAttachmentRemove: function (oEvent) {
      var oItem = oEvent.getParameter("item");
      if (!oItem) { return; }

      var oAttModel = this.getView().getModel("attachments");
      var aList = oAttModel.getProperty("/list");
      var iIndex = aList.findIndex(function (f) { return f._uploadSetItem === oItem; });
      if (iIndex === -1) { return; }

      aList.splice(iIndex, 1);
      oAttModel.setProperty("/list", aList);
    },

    // Queued files aren't uploaded anywhere yet (metadata-only until the
    // ticket is saved — see _queuePendingAttachments), so there's nothing
    // to open/download until then.
    onAttachmentDownload: function () {
      MessageToast.show("Save the ticket first to open this attachment.");
    },

    /* ---------------------------------------------------------
     * Queue one Attachment create per pending file as a nested entity
     * under the draft's own "attachments" composition (metadata only —
     * matches your schema which stores storagePath, not binary). This
     * only queues the requests; onSave's submitBatch is what actually
     * sends them, together with the ticket's own field edits.
     *
     * If you later add a real upload endpoint, POST the binary
     * there first and store the returned URL in storagePath.
     * ------------------------------------------------------- */
    _queuePendingAttachments: function () {
      var oAttModel = this.getView().getModel("attachments");
      var aList = oAttModel.getProperty("/list") || [];
      if (!aList.length) { return; }

      var oModel = this.getView().getModel();
      var oAttBinding = oModel.bindList("attachments", this._oTicketContext, [], [], {
        $$updateGroupId: "itsmGroup"
      });

      aList.forEach(function (f) {
        oAttBinding.create({
          fileName: f.fileName,
          originalName: f.originalName,
          mimeType: f.mimeType,
          fileSize: f.fileSize,
          storagePath: "/uploads/" + f.fileName  // placeholder
        });
      });
    },

    /* ---------------------------------------------------------
     * History timeline formatters
     * ------------------------------------------------------- */
    formatHistoryText: function (sFieldName, sOld, sNew) {
      var sLabel = FIELD_LABELS[sFieldName] || sFieldName;
      var sOldDisplay = this._resolveHistoryValue(sOld);
      var sNewDisplay = this._resolveHistoryValue(sNew);
      if (!sOldDisplay) { return sLabel + ' set to "' + sNewDisplay + '".'; }
      return sLabel + ' changed from "' + sOldDisplay + '" to "' + sNewDisplay + '".';
    },

    // Old/new values on TicketHistory are raw strings — an association's ID
    // for lookup/master fields, or the literal value for scalar fields.
    // Resolve through the cached label map when it's a known ID; otherwise
    // show it as-is.
    _resolveHistoryValue: function (sValue) {
      if (!sValue) { return sValue; }
      var mLabels = this._mLabels || {};
      return mLabels[sValue] || sValue;
    },

    formatChangedBy: function (oChangedBy) {
      return (oChangedBy && oChangedBy.name) || "System";
    },

    // OData v4 delivers timestamps as ISO strings; format them for display.
    formatDateTime: function (sValue) {
      if (!sValue) { return ""; }
      var oDate = new Date(sValue);
      return isNaN(oDate.getTime()) ? "" : oDate.toLocaleString();
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
