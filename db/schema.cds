namespace itsm;

using { cuid, managed } from '@sap/cds/common';


/*=========================================================
    MASTER DATA CONTEXT
=========================================================*/ 
context master {

    @assert.unique.typeCode: [lookupType, code]
    entity LookupValue : cuid, managed {
        lookupType   : String(50)  @assert.notNull;
        code         : String(50)  @assert.notNull;
        name         : localized String(100);
        description  : localized String(255);
        parent       : Association to LookupValue;
        sequence     : Integer;
        isDefault    : Boolean default false;
        isActive     : Boolean default true;
    }

    entity TicketCounter : managed {
        key prefix : String(10);
        lastNumber : Integer default 1;
    }

    entity User : cuid, managed {
        userId   : String(50) @assert.unique;
        name     : String(100);
        email    : String(100);
        isActive : Boolean default true;
    }

    entity SupportTeam : cuid, managed {
        teamCode : String(50) @assert.unique;
        name     : String(100);
        isActive : Boolean default true;
    }

    entity SystemMaster : cuid, managed {
        systemId    : String(50) @assert.unique;
        name        : String(100);
        description : String(255);
    }

    entity SoftwareComponent : cuid, managed {
        componentCode : String(50) @assert.unique;
        name          : String(100);
    }

    entity ConfigurationItem : cuid, managed {
        ciCode      : String(50) @assert.unique;
        name        : String(100);
        description : String(255);
    }
}


/*=========================================================
    TRANSACTIONAL DATA CONTEXT
=========================================================*/
context txn {

    /*---------------------------------------------------------
        MAIN TICKET
    ---------------------------------------------------------*/
    @cds.search: { ticketNumber, shortDescription }
    entity Ticket : managed {

        // Identity
        key ticketID     : String(30);
        ticketNumber     : String(30) @assert.unique;
        ticketType       : String(50);

        // Generic information
        shortDescription : String(255);
        status           : String(50);
        priority         : String(50);

        // Ownership (UI-resolved codes/ids)
        reportedBy       : String(50);
        messageProcessor : String(50);
        supportTeam      : String(50);

        // SLA
        firstResponseAt  : Timestamp;
        dueAt            : Timestamp;
        completedAt      : Timestamp;

        // Child collections
        attachments      : Composition of many Attachment
                           on attachments.ticket = $self;

        comments         : Composition of many TicketComment
                           on comments.ticket = $self;

        history          : Composition of many TicketHistory
                           on history.ticket = $self;

        transactions     : Composition of many TicketTransaction
                           on transactions.ticket = $self;

        scheduledActions : Composition of many ScheduledAction
                           on scheduledActions.ticket = $self;

        incidentForm     : Composition of one IncidentForm
                           on incidentForm.ticket = $self;
    }

    /*---------------------------------------------------------
        INCIDENT FORM (1:1 with Ticket)
    ---------------------------------------------------------*/
    entity IncidentForm : cuid {

        ticket : Association to Ticket;

        description         : LargeString;

        // UI-managed dropdown values
        category1           : String(100);
        category2           : String(100);
        category3           : String(100);
        category4           : String(100);
        solutionCategory    : String(100);

        impact              : String(50);
        urgency             : String(50);
        recommendedPriority : String(50);

        language            : String(50);
        isStandard          : Boolean default false;

        // Previously master associations — now plain codes
        system              : String(50);
        softwareComponent   : String(50);
        softwareVersion     : String(50);
        supportPackage      : Integer;
        configurationItem   : String(50);
        relatedRFC          : String(30);

        irtStatus           : String(50);
        mptStatus           : String(50);

        sapNotes            : Composition of many TicketSAPNote
                              on sapNotes.ticketForm = $self;

        sapNoteSearch       : Composition of one SAPNoteSearchCriteria
                              on sapNoteSearch.ticketForm = $self;
    }

    /*---------------------------------------------------------
        ATTACHMENTS
    ---------------------------------------------------------*/
    entity Attachment : cuid, managed {
        ticket       : Association to Ticket;
        fileName     : String(255);
        originalName : String(255);
        mimeType     : String(100) @Core.IsMediaType;
        fileSize     : Integer;
        content      : LargeBinary @Core.MediaType: mimeType;
        storagePath  : String(500);
    }

    /*---------------------------------------------------------
        SAP NOTES ATTACHED TO INCIDENT FORM
    ---------------------------------------------------------*/
    entity TicketSAPNote : cuid, managed {
        ticketForm    : Association to IncidentForm;
        sapNoteNumber : String(20);
        description   : LargeString;
        details       : LargeString;
        component     : String(50);
        status        : String(50);
    }

    /*---------------------------------------------------------
        SAP NOTE SEARCH CRITERIA
    ---------------------------------------------------------*/
    entity SAPNoteSearchCriteria : cuid, managed {
        ticketForm                : Association to IncidentForm;
        componentsStartWith       : String(100);
        componentsExact           : String(100);
        excludedComponents        : String(100);
        supportPackageGreaterThan : Integer;
        supportPackageEqual       : Integer;
        fuzzyThreshold            : String(50);
        releasedOnPreDefined      : String(50);
        releasedOnFree            : Date;
    }

    /*---------------------------------------------------------
        RELATED TRANSACTIONS
    ---------------------------------------------------------*/
    entity TicketTransaction : cuid, managed {
        ticket          : Association to Ticket;
        transactionId   : String(30);
        transaction     : String(30);
        description     : String(255);
        category        : String(50);
        status          : String(50);
        priority        : String(50);
        transactionType : String(50);
    }

    /*---------------------------------------------------------
        SCHEDULED ACTIONS
    ---------------------------------------------------------*/
    entity ScheduledAction : cuid, managed {
        ticket           : Association to Ticket;
        actionDefinition : String(255);
        processingType   : String(50);
        status           : String(50);
        executable       : Boolean default false;
        scheduledAt      : Timestamp;
    }

    /*---------------------------------------------------------
        COMMENTS
    ---------------------------------------------------------*/
    entity TicketComment : cuid, managed {
        ticket  : Association to Ticket;
        comment : LargeString;
        author  : String(50);
    }

    /*---------------------------------------------------------
        HISTORY / AUDIT
    ---------------------------------------------------------*/
    entity TicketHistory : cuid, managed {
        ticket    : Association to Ticket;
        fieldName : String(100);
        oldValue  : LargeString;
        newValue  : LargeString;
        changedBy : String(50);
    }
}