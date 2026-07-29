# ITSM Incident Management

An SAP CAP + SAP UI5 IT Service Management (ITSM) application.

File or Folder | Purpose
---------|----------
`app/` | SAPUI5 frontend (incident dashboard, ticket list, incident form) and the approuter
`db/` | domain model (`schema.cds`) and master data (`db/data`)
`srv/` | OData V4 service definition and business logic (`srv/service.cds`, `srv/service.js`)
`mta.yaml` | multi-target application descriptor for SAP BTP deployment
`xs-security.json` | XSUAA role/scope definition

## Local development

```
npm install
npx cds watch
```

This starts the CAP service (OData V4 at `/odata/v4/incident/`) and serves the UI5 app.

## Learn More

Learn more at <https://cap.cloud.sap>.
