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
@path: 'ITSMService'
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
    // thing allowed to move a counter is the atomic bump in
    // srv/utils/ticket-number.js, otherwise two clients could hand out the
    // same ticket number.
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
    // Deliberately NOT @odata.draft.enabled: nothing needs the draft
    // protocol, so Create/Save/Submit are plain CREATE and UPDATE — which
    // is exactly what srv/handlers/ticket.js hooks.
    entity Tickets as projection on txn.Ticket excluding { history } actions {

        /*-------------------------------------------------
            SUBMIT — the ONLY way a ticket leaves DRAFT.

            A bound action rather than a status PATCH, because
            the requirement is that no other operation can make
            the DRAFT -> OPEN transition. on('UPDATE') refuses
            that move explicitly, so this action is the single
            door. Everything else about a ticket is still plain
            CRUD.
        -------------------------------------------------*/
        action submitTicket() returns Tickets;
    };


    @Capabilities: {
        InsertRestrictions.Insertable: false,
        UpdateRestrictions.Updatable : false,
        DeleteRestrictions.Deletable : false
    }
    entity IncidentForms as projection on txn.IncidentForm;

    @Capabilities: {
        InsertRestrictions.Insertable: false,
        UpdateRestrictions.Updatable : false,
        DeleteRestrictions.Deletable : false
    }
    entity Attachments as projection on txn.Attachment;

    @Capabilities: {
        InsertRestrictions.Insertable: false,
        UpdateRestrictions.Updatable : false,
        DeleteRestrictions.Deletable : false
    }
    entity TicketSAPNotes as projection on txn.TicketSAPNote;

    @Capabilities: {
        InsertRestrictions.Insertable: false,
        UpdateRestrictions.Updatable : false,
        DeleteRestrictions.Deletable : false
    }
    entity SAPNoteSearchCriteria as projection on txn.SAPNoteSearchCriteria;

    @Capabilities: {
        InsertRestrictions.Insertable: false,
        UpdateRestrictions.Updatable : false,
        DeleteRestrictions.Deletable : false
    }
    entity TicketTransactions as projection on txn.TicketTransaction;

    @Capabilities: {
        InsertRestrictions.Insertable: false,
        UpdateRestrictions.Updatable : false,
        DeleteRestrictions.Deletable : false
    }
    entity ScheduledActions as projection on txn.ScheduledAction;

    @Capabilities: {
        InsertRestrictions.Insertable: false,
        UpdateRestrictions.Updatable : false,
        DeleteRestrictions.Deletable : false
    }
    entity TicketComments as projection on txn.TicketComment;

    // Append-only audit trail: written by server-side handlers on every
    // ticket UPDATE, submit and assignment — never directly writable
    // through the API.
    @readonly
    entity TicketHistory as projection on txn.TicketHistory;

    /*=====================================================
        WHO AM I — the authenticated user, joined to their
        master.User row where one exists, plus the role flags
        the UI needs to decide which screens to offer.
        `ID` is null when the signed-in identity has no
        matching master.User row: callers must tolerate that
        (it means "no personal queue", not "not logged in").
    =====================================================*/

    type CurrentUser {
        ID             : UUID;          // master.User key, null if no such row
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
        own TicketHistory rows, since it updates the persistence
        entity directly and the UPDATE hooks never fire for it.
        Returns the number of tickets actually changed.
    =====================================================*/
    @requires: 'ServiceGroup'
    action assignTickets(
        tickets          : many String(30),   // Ticket.ticketID
        messageProcessor : String(50),        // User.userId
        supportTeam      : String(50)         // SupportTeam.teamCode
    ) returns Integer;
}
