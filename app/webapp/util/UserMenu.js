sap.ui.define([
  "sap/m/Popover",
  "sap/m/VBox",
  "sap/m/Text",
  "sap/m/Button"
], function (Popover, VBox, Text, Button) {
  "use strict";

  /* =========================================================
   * The "who am I / sign out" popover behind the header avatar.
   *
   * A plain module rather than a base controller: all four pages
   * need the same popover, but they already extend
   * sap.ui.core.mvc.Controller directly and re-parenting them
   * would be a much bigger change than this earns. Each controller
   * just forwards its press event here.
   *
   * The popover is built once per component and reused, so
   * switching pages does not leak a new one each time.
   * ======================================================= */

  var POPOVER_KEY = "_itsmUserMenu";

  function build(oComponent) {
    var oPopover = new Popover({
      showHeader: false,
      placement: "Bottom",
      contentWidth: "15rem",
      content: [
        new VBox({
          items: [
            new Text({ text: "{user>/name}" }).addStyleClass("profileName"),
            new Text({ text: "{user>/roleLabel}" }).addStyleClass("profileRole"),
            new Text({ text: "{user>/email}", visible: "{= !!${user>/email} }" }).addStyleClass("profileEmail"),
            new Button({
              text: "Sign Out",
              icon: "sap-icon://log",
              width: "100%",
              press: function () {
                oPopover.close();
                oComponent.signOut();
              }
            }).addStyleClass("sapUiSmallMarginTop")
          ]
        }).addStyleClass("sapUiSmallMargin profileCard")
      ]
    });

    // The popover lives outside any view, so it needs the component's
    // "user" model handed to it explicitly.
    oPopover.setModel(oComponent.getModel("user"), "user");
    return oPopover;
  }

  return {
    open: function (oSource, oComponent) {
      if (!oComponent[POPOVER_KEY]) {
        oComponent[POPOVER_KEY] = build(oComponent);
      }
      oComponent[POPOVER_KEY].openBy(oSource);
    }
  };
});
