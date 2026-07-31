using { itsm.master as master, itsm.txn as txn } from '../db/schema';

/*=========================================================
    ROLES
      Agent        — raise and process incidents. Everyone.
      ServiceGroup — sees every incident in the system and
                     assigns them to engineers.
      Admin        — master data.
    Locally these come from the mocked users in package.json;
    on CF from the XSUAA role templates in xs-security.json.
=========================================================*/
@path: '/odata/v4/itsm'
@requires: 'authenticated-user'
service ITSMService {

    /*=====================================================
        MASTER DATA
        Full CRUD — maintained by admins, referenced
        everywhere else by association.
    =====================================================*/
    entity LookupValues       as projection on master.LookupValue;
    entity Users               as projection on master.User;
    entity SupportTeams        as projection on master.SupportTeam;
    entity Systems              as projection on master.SystemMaster;
    entity SoftwareComponents  as projection on master.SoftwareComponent;
    entity ConfigurationItems  as projection on master.ConfigurationItem;

    // Per-prefix ticket number counters. Read-only over the API: the only
    // thing allowed to move a counter is the atomic bump in handlers/tickets.js,
    // otherwise two clients could hand out the same ticket number.
    @readonly
    entity TicketCounters as projection on master.TicketCounter;

    /*=====================================================
        TICKET — the aggregate root, keyed on ticketID.

        Since the entity split, the generic header lives here and
        the incident-specific fields live on IncidentForm, reached
        through the `incidentForm` composition. Clients that need
        both read them with $expand=incidentForm and write them
        with a deep insert/update.

        `history` is excluded: it's an append-only audit trail
        written by this service's own handlers, not something a
        user should be able to add or remove rows from.
    =====================================================*/
    // Deliberately NOT @odata.draft.enabled — see srv/handlers/tickets.js.
    // The UI is freestyle SAPUI5, not Fiori Elements, so nothing needs the
    // draft protocol; without it Create/Save/Submit are plain CREATE and
    // UPDATE, which is what the lifecycle handlers hook.
    entity Tickets as projection on txn.Ticket excluding { history };

    // Exposed in its own right as well as through the composition, so the
    // form can be read or patched without going through the ticket.
    entity IncidentForms as projection on txn.IncidentForm;

    entity Attachments          as projection on txn.Attachment;
    entity TicketSAPNotes       as projection on txn.TicketSAPNote;
    entity SAPNoteSearchCriteria as projection on txn.SAPNoteSearchCriteria;
    entity TicketTransactions   as projection on txn.TicketTransaction;
    entity ScheduledActions     as projection on txn.ScheduledAction;
    entity TicketComments       as projection on txn.TicketComment;

    // Append-only audit trail: written by server-side handlers on
    // every Ticket SAVE, never directly writable through the API.
    @readonly
    entity TicketHistory as projection on txn.TicketHistory;

    // Read-only preview of the next ticket number, for display on the
    // create form before the ticket is actually saved. The authoritative
    // number is (re)assigned server-side on SAVE.
    function nextTicketNumber(ticketTypeCode : String) returns String;

    /*=====================================================
        WHO AM I — the authenticated user, joined to their
        master.User row where one exists, plus the role flags
        the UI needs to decide which screens to offer.
        `ID` is null when the signed-in identity has no
        matching master.User row: callers must tolerate that
        (it means "no personal queue", not "not logged in").
    =====================================================*/
    type CurrentUser {
        ID             : UUID;
        userId         : String(50);
        name           : String(100);
        email          : String(100);
        isServiceGroup : Boolean;
        isAdmin        : Boolean;
    }

    function currentUser() returns CurrentUser;

    /*=====================================================
        SERVICE GROUP: (re)assignment.
        Sets the engineer and/or the support team on tickets
        that are already active. Deliberately an action rather
        than a PATCH: it routes many tickets in one
        transaction with one authorization check, which a
        per-ticket PATCH from the client cannot do. Writes its
        own TicketHistory rows, since the SAVE-based audit
        handler never fires for this path.
        Returns the number of tickets actually changed.
    =====================================================*/
    @requires: 'ServiceGroup'
    action assignTickets(
        tickets          : many String(30),   // Ticket.ticketID
        messageProcessor : String(50),        // User.userId
        supportTeam      : String(50)         // SupportTeam.teamCode
    ) returns Integer;
}
