sap.ui.define([
  "sap/ui/core/UIComponent",
  "sap/ui/core/mvc/XMLView",
  "itsm/ui/util/Lookups",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast"
], function (UIComponent, XMLView, Lookups, JSONModel, MessageToast) {
  "use strict";

  /* =========================================================
   * Sign-in.
   *
   * The CAP service is annotated @requires:'authenticated-user',
   * so every OData request needs an identity. Locally that is
   * CAP's `mocked` auth strategy over HTTP Basic (see the users
   * in package.json); on Cloud Foundry the approuter and XSUAA
   * do the sign-in before the app is ever loaded and this
   * component just picks the session up from currentUser().
   *
   * Two deliberate choices:
   *  - credentials are validated with a plain fetch() using
   *    credentials:"omit" rather than by letting the OData model
   *    hit a 401. A 401 reaching the browser pops the native
   *    basic-auth dialog, which would fight our own login page;
   *    per the Fetch spec a credentials:"omit" request never
   *    triggers that prompt.
   *  - signing in and out reloads the page. ODataModel v4 refuses
   *    changeHttpHeaders() once its bindings hold data, so
   *    switching user in place is not supported — a reload hands
   *    Component.init a virgin model to set the header on, which
   *    is also the only way to be sure no previous user's data
   *    survives in a cache.
   * ======================================================= */

  var SESSION_KEY = "itsm.session";

  /* =========================================================
   * ROUTE ACCESS POLICY — the single place that decides who may
   * see which page.
   *
   * The role itself is NOT decided here: it comes from the
   * backend, which derives it from the authenticated identity
   * (req.user.is('ServiceGroup') in srv/handlers/assignment.js)
   * and returns it from currentUser(). This table only maps that
   * role onto routes, so there is no second definition of what a
   * Service Group user is.
   *
   *   serviceGroup : only a Service Group user may open it
   *   endUser      : only a non-Service-Group user may open it
   *   (absent)     : open to any signed-in user
   *
   * Service Group users and end users get completely separate
   * page sets; "detail", "create" and "analytics" stay shared
   * because a coordinator has to be able to open an incident and
   * the SLA board from their own dashboard.
   * ======================================================= */
  var ROUTE_POLICY = {
    dashboard: "endUser",            // the normal user dashboard
    list:      "endUser",            // the normal user ticket list
    serviceGroup:        "serviceGroup",
    serviceGroupTickets: "serviceGroup"
  };

  // Where each role starts, and where "home" sends them.
  var HOME_ROUTE = { serviceGroup: "serviceGroup", endUser: "dashboard" };

  return UIComponent.extend("itsm.ui.Component", {
    metadata: { manifest: "json" },

    // Runs inside UIComponent.prototype.init, after the manifest's models
    // exist but before the root view (and therefore any controller) is
    // built. That is the only window in which the OData model's auth header
    // can be set before something tries to use it — hence also
    // "earlyRequests": false in the manifest.
    createContent: function () {
      this._restoreSession();
      return UIComponent.prototype.createContent.apply(this, arguments);
    },

    init: function () {
      this.setModel(new JSONModel(this._emptyUser()), "user");

      UIComponent.prototype.init.apply(this, arguments);

      var oRouter = this.getRouter();
      oRouter.attachRouteMatched(this._onRouteMatched, this);

      if (this.isAuthenticated()) {
        // Status/priority/impact/urgency are plain codes since the entity
        // split, so their display names come from LookupValue instead of an
        // $expand. Loaded before the router starts, so no binding ever
        // renders a raw code first and then flips to a name.
        var that = this;
        Lookups.load(this.getModel()).then(function () {
          that._startRouting();
        });
        return;
      }

      this._showLogin();
    },

    // Signed out, the router is deliberately never initialized and the
    // login view is placed directly (see _showLogin): neither routeMatched
    // nor beforeRouteMatched can cancel a target, so landing on
    // #/service-group would build and briefly show that page — firing
    // unauthenticated OData requests — before any redirect took effect.
    _startRouting: function () {
      var oRouter = this.getRouter();

      // A support coordinator's job starts at their analytics view, not at
      // the end-user dashboard. Only when they arrived without a deep link
      // of their own, so a bookmarked or shared URL still wins (it is then
      // policed by _onRouteMatched like any other navigation).
      //
      // The hash is set BEFORE the router starts rather than navTo'd after:
      // initialize() would otherwise match the empty pattern first, which
      // builds and data-loads the end-user dashboard for a page a Service
      // Group user must never see.
      if (this._role() === "serviceGroup" && !this._hasInitialHash()) {
        window.location.hash = "#/service-group";
      }
      oRouter.initialize();
    },

    // "" and "#/" both mean "no route was asked for". Sign-in itself lands
    // on "#/" (see Login.controller), so this is the normal case.
    _hasInitialHash: function () {
      var sHash = (window.location.hash || "").replace(/^#\/?/, "");
      return sHash !== "";
    },

    _showLogin: function () {
      var that = this;
      // rootControlLoaded(), not getRootControl(): the component is created
      // asynchronously, so the root view does not exist yet at init time.
      // runAsOwner, so the view's controller can reach getOwnerComponent().
      // A view created outside the component's owner context has no owner,
      // and every getOwnerComponent() call in it returns undefined.
      var pView;
      this.runAsOwner(function () {
        pView = XMLView.create({ id: that.createId("login"), viewName: "itsm.ui.view.Login" });
      });

      Promise.all([this.rootControlLoaded(), pView]).then(function (aResult) {
        var oApp = aResult[0].byId("app");
        oApp.removeAllPages();
        oApp.addPage(aResult[1]);
      }).catch(function (oErr) {
        // eslint-disable-next-line no-console
        console.error("Could not show the sign-in page:", oErr);
        that.getModel("user").setData(that._emptyUser());
      });
    },

    // Taken from the manifest rather than hard-coded, so the sign-in probe
    // and the OData model can never end up pointing at different services.
    // It is an absolute path ("/odata/v4/itsm/"): the app itself is served
    // from /webapp/, so a relative URL would resolve under that instead.
    _serviceUrl: function () {
      return this.getManifestEntry("/sap.app/dataSources/itsmService/uri");
    },

    _emptyUser: function () {
      return {
        authenticated: false, ID: null, userId: "", name: "", email: "",
        initials: "", roleLabel: "", isServiceGroup: false, isAdmin: false
      };
    },

    /* ---------------------------------------------------------
     * Session storage, not local storage: a browser tab is the
     * natural scope for "who am I testing as", and it lets two
     * windows sit side by side as two different users.
     * ------------------------------------------------------- */
    _restoreSession: function () {
      var oSession = null;
      try {
        var sSaved = window.sessionStorage.getItem(SESSION_KEY);
        oSession = sSaved && JSON.parse(sSaved);
      } catch (e) { /* malformed or blocked storage — treat as signed out */ }

      if (!oSession || !oSession.auth || !oSession.profile) { return; }

      this.getModel().changeHttpHeaders({ Authorization: oSession.auth });
      this._applyProfile(oSession.profile);
    },

    _applyProfile: function (oProfile) {
      this.getModel("user").setData({
        authenticated: true,
        ID: oProfile.ID || null,
        userId: oProfile.userId || "",
        name: oProfile.name || oProfile.userId || "",
        email: oProfile.email || "",
        initials: this._initials(oProfile.name || oProfile.userId || "?"),
        roleLabel: oProfile.isAdmin
          ? "Administrator"
          : (oProfile.isServiceGroup ? "Service Group" : "End User"),
        isServiceGroup: !!oProfile.isServiceGroup,
        isAdmin: !!oProfile.isAdmin
      });
    },

    _initials: function (sName) {
      var aParts = sName.trim().split(/\s+/);
      var sFirst = aParts[0] ? aParts[0].charAt(0) : "";
      var sLast = aParts.length > 1 ? aParts[aParts.length - 1].charAt(0) : "";
      return (sFirst + sLast).toUpperCase() || "?";
    },

    isAuthenticated: function () {
      return this.getModel("user").getProperty("/authenticated");
    },

    /* ---------------------------------------------------------
     * Validate credentials and start a session. Resolves with the
     * profile; rejects with a message fit to show the user.
     * The caller reloads the page — see the note at the top.
     * ------------------------------------------------------- */
    signIn: function (sUser, sPassword) {
      var that = this;
      var sAuth = "Basic " + window.btoa(sUser + ":" + sPassword);

      return fetch(this._serviceUrl() + "currentUser()", {
        headers: {
          Authorization: sAuth,
          Accept: "application/json",
          // Marks this as XHR so the server drops its
          // "WWW-Authenticate: Basic" challenge and the browser does not
          // pop its own login dialog over ours (see srv/server.js).
          "X-Requested-With": "XMLHttpRequest"
        },
        // Cookies MUST be sent. When the app is served through an
        // authenticating proxy — BAS port forwarding, a CF approuter —
        // the proxy needs its own session cookie, and a cookieless
        // request is rejected with the proxy's 401 before CAP sees it.
        // That produced "wrong username or password" for valid users in
        // BAS while localhost, which has no proxy, worked fine.
        credentials: "same-origin"
      }).then(function (oResponse) {
        if (oResponse.status === 401) {
          // Tell the two 401s apart. CAP answers with JSON; an
          // authenticating proxy answers with its own HTML login page,
          // which means the workspace session expired rather than the
          // credentials being wrong.
          var sType = oResponse.headers.get("content-type") || "";
          throw new Error(sType.indexOf("html") !== -1
            ? "The session with the server expired. Reload the page and sign in again."
            : "Wrong user name or password.");
        }
        if (!oResponse.ok) {
          throw new Error("Sign-in failed (" + oResponse.status + ").");
        }
        return oResponse.json();
      }).then(function (oProfile) {
        try {
          window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ auth: sAuth, profile: oProfile }));
        } catch (e) {
          throw new Error("Session storage is blocked in this browser, so sign-in cannot be kept.");
        }
        that._applyProfile(oProfile);
        return oProfile;
      });
    },

    signOut: function () {
      try {
        window.sessionStorage.removeItem(SESSION_KEY);
      } catch (e) { /* nothing kept, nothing to clear */ }
      this.getModel("user").setData(this._emptyUser());
      // Full reload: the OData model cannot have its auth header changed
      // once its bindings hold data (see the note at the top).
      window.location.hash = "#/login";
      window.location.reload();
    },

    /* ---------------------------------------------------------
     * The role of the signed-in user, as one of the keys used by
     * ROUTE_POLICY. Read from the "user" model, which Component
     * fills from the backend's currentUser() — so the role is
     * never inferred in the client.
     * ------------------------------------------------------- */
    _role: function () {
      return this.getModel("user").getProperty("/isServiceGroup") ? "serviceGroup" : "endUser";
    },

    /** The landing route for the signed-in user. */
    homeRoute: function () {
      return HOME_ROUTE[this._role()];
    },

    /** Send the user to their own dashboard, whichever that is. */
    navToHome: function () {
      this.getRouter().navTo(this.homeRoute());
    },

    /* ---------------------------------------------------------
     * ROUTE GUARD — enforced on every navigation, in both
     * directions.
     *
     * routeMatched fires for hand-typed URLs, bookmarks, the
     * browser back button and in-app navTo alike, so this is the
     * one choke point that covers all of them. Redirects use
     * replace (the third argument) so the blocked page does not
     * stay in history and bounce the user back and forth.
     *
     * This is convenience and containment, not the security
     * boundary: the real protection is on the server, where the
     * service requires an authenticated user and assignTickets is
     * annotated @requires:'ServiceGroup'. Hiding a page never
     * protects the data behind it.
     * ------------------------------------------------------- */
    _onRouteMatched: function (oEvent) {
      var sRoute = oEvent.getParameter("name");
      var sRequired = ROUTE_POLICY[sRoute];

      // No policy for this route: open to any signed-in user.
      if (!sRequired) { return; }

      var sRole = this._role();
      if (sRequired === sRole) { return; }

      MessageToast.show(sRole === "serviceGroup"
        ? "That page is not part of the Service Group workspace."
        : "The Service Group dashboard needs the Service Group role.");

      this.getRouter().navTo(HOME_ROUTE[sRole], {}, true);
    }

  });
});
