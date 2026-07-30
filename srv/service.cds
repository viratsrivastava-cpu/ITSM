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

    /*=====================================================
        TICKET — draft-enabled aggregate root.
        `history` is excluded here (see TicketHistory below):
        it's an append-only audit trail written by this
        service's own handlers, not something a user should
        be able to add/remove rows to while editing a draft.
    =====================================================*/
    @odata.draft.enabled
    entity Tickets as projection on txn.Ticket excluding { history };

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
    function nextTicketNumber() returns String;

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
        than a PATCH: Tickets is draft-enabled, so a plain
        update would mean an edit/patch/activate round-trip
        per ticket — unworkable for the bulk assignment the
        Service Group dashboard is built around. Writes its
        own TicketHistory rows, since the SAVE-based audit
        handler never fires for this path.
        Returns the number of tickets actually changed.
    =====================================================*/
    @requires: 'ServiceGroup'
    action assignTickets(
        tickets          : many UUID,
        messageProcessor : UUID,
        supportTeam      : UUID
    ) returns Integer;
}
