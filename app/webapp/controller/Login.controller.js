sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel"
], function (Controller, JSONModel) {
  "use strict";

  /* =========================================================
   * Sign-in screen. The credential handling itself lives on the
   * Component (see Component.signIn) — this controller is just
   * the form around it.
   * ======================================================= */

  // The mocked users configured in package.json under
  // cds.requires.auth.users, listed here so a role can be switched
  // with one click while testing. Local development only: see
  // _isLocal below, and the real role templates in xs-security.json.
  var DEMO_USERS = [
    { userId: "jdoe",    password: "jdoe",    name: "John Doe",     roleLabel: "End User",      roleState: "Information" },
    { userId: "mgarcia", password: "mgarcia", name: "Maria Garcia", roleLabel: "End User",      roleState: "Information" },
    { userId: "asmith",  password: "asmith",  name: "Alice Smith",  roleLabel: "Service Group", roleState: "Success" },
    { userId: "kwong",   password: "kwong",   name: "Kevin Wong",   roleLabel: "Administrator", roleState: "Warning" }
  ];

  return Controller.extend("itsm.ui.controller.Login", {

    onInit: function () {
      this.getView().setModel(new JSONModel({
        user: "",
        password: "",
        busy: false,
        showDemoUsers: this._isLocal(),
        demoUsers: DEMO_USERS
      }), "login");

      this.getOwnerComponent().getRouter()
        .getRoute("login")
        .attachPatternMatched(this._onMatched, this);
    },

    // The demo user list is a development affordance, not something to
    // ship to a landscape where XSUAA does the sign-in.
    //
    // Tested by excluding the productive domains rather than by matching
    // "localhost": a dev workspace is not served from localhost. SAP
    // Business Application Studio serves the app from
    // port4004-workspaces-ws-xxxxx.<region>.applicationstudio.cloud.sap,
    // so a localhost check hid the test users exactly where they are
    // needed most and left an unlabelled login form.
    _isLocal: function () {
      return !/\.(cfapps|hana)\.ondemand\.com$/i.test(window.location.hostname);
    },

    _onMatched: function () {
      this._setError(null);
      this.getView().getModel("login").setProperty("/password", "");
    },

    onDemoUserPress: function (oEvent) {
      var oCtx = oEvent.getSource().getBindingContext("login");
      if (!oCtx) { return; }
      var oModel = this.getView().getModel("login");
      oModel.setProperty("/user", oCtx.getProperty("userId"));
      oModel.setProperty("/password", oCtx.getProperty("password"));
      this.onSignIn();
    },

    onSignIn: function () {
      var that = this;
      var oModel = this.getView().getModel("login");
      var sUser = (oModel.getProperty("/user") || "").trim();
      var sPassword = oModel.getProperty("/password") || "";

      if (!sUser) {
        this._setError("Enter a user name.");
        return;
      }

      this._setError(null);
      oModel.setProperty("/busy", true);

      this.getOwnerComponent().signIn(sUser, sPassword).then(function () {
        // Reload rather than navigate: the OData model's auth header can
        // only be set on a model whose bindings hold no data yet, so the
        // session is picked up cleanly in Component.init. See Component.js.
        window.location.hash = "#/";
        window.location.reload();
      }).catch(function (oErr) {
        oModel.setProperty("/busy", false);
        oModel.setProperty("/password", "");
        that._setError((oErr && oErr.message) || "Sign-in failed.");
      });
    },

    _setError: function (sText) {
      var oStrip = this.byId("loginError");
      oStrip.setVisible(!!sText);
      if (sText) { oStrip.setText(sText); }
    }

  });
});
