using { ITSMService } from '../srv/service';

/* =========================================================
   UI ANNOTATIONS

   ⚠ INERT IN THE CURRENT APPLICATION.

   app/webapp is a freestyle SAPUI5 app — hand-written XML views
   with their own controllers (see view/Main.view.xml and
   controller/Main.controller.js). Nothing renders these
   annotations, so changing them will not move a single button.

   This file previously declared UI.DataFieldForAction entries for
   saveTicket and submitTicket. Those custom actions no longer
   exist: the two-phase flow now runs entirely on CAP's CRUD
   lifecycle (srv/handlers/tickets.js), so there is nothing for a
   DataFieldForAction to point at.

   Under Fiori Elements the same flow would need no annotations at
   all for Save — an object page on a draft-enabled entity renders
   the standard draft Save, which raises SAVE on the server, which
   is where the number and the DRAFT status are stamped. "Submit"
   would be a plain edit of the status field, validated by the same
   before-SAVE handler.
   ========================================================= */

annotate ITSMService.Tickets with {

    // Assigned server-side while the draft is activated; never typed.
    ticketNumber @readonly;
}
