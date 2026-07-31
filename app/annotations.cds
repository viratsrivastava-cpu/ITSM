using { ITSMService } from '../srv/service';

/* =========================================================
   UI ANNOTATIONS FOR THE TWO-PHASE SAVE / SUBMIT FLOW

   ⚠ INERT IN THE CURRENT APPLICATION.

   app/webapp is a freestyle SAPUI5 app — hand-written XML
   views with their own controllers (see view/Main.view.xml
   and controller/Main.controller.js). Nothing renders these
   annotations, so changing them will not move a single button.

   The behaviour they describe is implemented for real in the
   freestyle UI:
     - Save / Submit visibility ....... Main.controller.js,
       _setMode() + _setModeFromStatus()
     - ticketNumber read-only ......... Main.view.xml, the
       Input has editable="false"

   This file is kept so the intent is declared in one place,
   and so that adopting Fiori Elements later is a matter of
   pointing a List Report / Object Page at ITSMService rather
   than re-deriving the rules. Delete it if you would rather
   not carry an unused file.
   ========================================================= */

annotate ITSMService.Tickets with {

    // Assigned by the server during saveTicket; never typed by a user.
    ticketNumber @readonly;
}

annotate ITSMService.Tickets with @(

    UI.Identification: [
        {
            $Type : 'UI.DataFieldForAction',
            Label : 'Save',
            Action: 'ITSMService.saveTicket',
            // Only meaningful while the draft has not been activated.
            @UI.Hidden: IsActiveEntity
        },
        {
            $Type : 'UI.DataFieldForAction',
            Label : 'Submit',
            Action: 'ITSMService.submitTicket',
            // Activated, and still sitting in DRAFT.
            @UI.Hidden: { $edmJson: { $Not: { $And: [
                { $Path: 'IsActiveEntity' },
                { $Eq: [ { $Path: 'status/code' }, 'DRAFT' ] }
            ]}}}
        }
    ]
);

// Determining actions: rendered in the object page footer rather than the
// header toolbar, which is where a Fiori Elements object page puts the
// primary "finish what you started" action.
annotate ITSMService.Tickets with @(
    UI.LineItem: [
        {
            $Type : 'UI.DataFieldForAction',
            Label : 'Submit',
            Action: 'ITSMService.submitTicket',
            Determining: true,
            @UI.Hidden: { $edmJson: { $Not: { $And: [
                { $Path: 'IsActiveEntity' },
                { $Eq: [ { $Path: 'status/code' }, 'DRAFT' ] }
            ]}}}
        }
    ]
);
