# What the client knows about Maccabi, and how it found out

Maccabi publishes no API for anything read here. Every request copies one that the member website, one of
its sub-apps or the public directory site sends for its own screens, and a website release may change any
of them without notice. A reader that meets an answer it was not built for refuses it; it never adapts.
The sections below say, part by part, what each reader was built from and how far that was confirmed.

Each section grades its knowledge in three steps:

- **seen live**: the request went to the real service and its answer was looked at. If a browser made the
  request and this client did not, the section says so.
- **front end**: the request, or the list of fields to expect, was worked out from the code Maccabi's own
  pages run.
- **fake only**: the reader is exercised against `test/fake/`, and no real answer has confirmed it.

Script file names change with each website build, so sections name the screen or sub-app to
open, not a file. Maccabi's public help pages explain what a service is for and say nothing about requests
or fields. A list returned by any reader is what one call returned; none of them stands for a full history.

## Sign-in

Code: [sms-sign-in.ts](../src/maccabi/sms-sign-in.ts), [http.ts](../src/maccabi/http.ts).

The steps are those of the public sign-in page: ID number, a code by SMS, then the hand-over to the portal.
How a dead session looks was measured on real traffic: the gateway redirects to the sign-in host or to
`/my.policy`, and the transport ends the session on either.

## Member scope and keeping a session open

Code: [member/context.ts](../src/maccabi/member/context.ts), `renew` in
[member/account.ts](../src/maccabi/member/account.ts).

To keep a session open the client sends `alive`, the call the portal's pages make on their own. A good
answer shows only that the call went through. How long Maccabi then keeps the session is Maccabi's decision
and cannot be read off it.

## Test results and laboratory

Code: [member/labs.ts](../src/maccabi/member/labs.ts),
[parse/recent-labs.ts](../src/maccabi/member/parse/recent-labs.ts); service `TestResultsAPI`.

Read from the test-results sub-app: the latest results, the followed results, the comparison of one test
over time, the report PDFs, printing as a list or a graph, and the irregular-only switch.

| Part | Confirmation |
| --- | --- |
| Latest results; comparison as JSON and as PDF; the PDF of a whole report | seen live |
| Followed results; choosing which test to compare | fake only |
| English COVID report | front end, fake only |

The English COVID report is taken only down the route the portal uses for a member whose English identity
details are already on file; the detail row's own flag decides whether it is offered.

Known behaviour, seen live: `lab-values-pdf` can get HTTP 404 for an older result.

## Imaging viewer

Code: [member/imaging.ts](../src/maccabi/member/imaging.ts),
[parse/viewer-study.ts](../src/maccabi/member/parse/viewer-study.ts).

The website's own requests supplied the hand-over from portal to viewer and the four reads a viewer
session allows. All of it was then run live from start to finish. An imaging row's `request_id`
is the study's DICOM Study Instance UID, which was checked against a real hand-over.

No viewer error was seen live, so the status codes the reader expects for one are assumptions.

## Visits, inquiries and administrative cases

Code: [member/visits.ts](../src/maccabi/member/visits.ts) (`AppointmentOrderAPI`),
[member/requests.ts](../src/maccabi/member/requests.ts) (`CommunicationWithDoctorAPI` and the cases
service), [parse/doctor-inquiry.ts](../src/maccabi/member/parse/doctor-inquiry.ts),
[parse/request-detail.ts](../src/maccabi/member/parse/request-detail.ts).

- **Visit documents.** Front end (the appointment-ordering sub-app). Visit-summary PDFs were seen live;
  the other documents of a visit are fake only.
- **Inquiries to a doctor.** Front end: the correspondence, the sick-permit documents issued
  automatically, form types 1 to 5 and the documents of the visit an inquiry belongs to. A selection of
  documents was seen live. The wider reader is fake only, and some populated branches of an inquiry have
  never been checked against a real answer.
- **Administrative cases.** Front end, fake only: the correspondence of a case and of a service request,
  the obligation and decision fields, attachments, and the printed decision.

## Prescriptions, purchases and the medical file

Code: [member/prescriptions.ts](../src/maccabi/member/prescriptions.ts),
[member/records.ts](../src/maccabi/member/records.ts); service `MedicalFileAPI`.

- **Prescriptions.** Front end, fake only: the rules that sort a prescription by status and mark it as
  permanent, and the names and codes of its alternatives.
- **Sensitivities.** Front end, fake only: the fields checked are those the front end displays.
- **Vaccination groups.** Seen live on 2026-10-28: for some groups Maccabi serves its HTML error page where
  the PDF should be.
- **Purchased medication.** The classic page can search by date and sort. Neither request has been seen, so
  neither is offered.
- **English medical summary.** Read in `records.ts`; not graded.

## Appointments and the slot search

Code: [member/scheduling.ts](../src/maccabi/member/scheduling.ts),
[parse/upcoming-list.ts](../src/maccabi/member/parse/upcoming-list.ts),
[parse/upcoming-appointment.ts](../src/maccabi/member/parse/upcoming-appointment.ts),
[parse/appointment-queries.ts](../src/maccabi/member/parse/appointment-queries.ts).

Everything here was read from the appointment-ordering sub-app, whose scripts were fetched from the real
site. Comments in `appointment-queries.ts` say what that front end does at each step and name the page that
does it. They describe the build that was read; a newer one may differ.

**Upcoming appointments.** The displayed fields, the provider's contact details and the visit instructions
are front end; a populated list is fake only.

**Looking for a slot.** The front end is the source for the visit types, the free slots, the instructions,
the member's eligibility, the rule for whether a provider can be booked online, the texts shown for a visit
type that is not available, and the two answer codes treated as an answer, `00` and `F4`. How far each
request got:

- **Seen live:** `appointments/visit_types`, which the pick-type page sends as it loads;
  `appointments/member-eligibilities`, sent when the page mounts and answered with HTTP 204; and
  `appointments/provider_appointments` with neither month nor day, sent when a visit type is chosen, both
  with slots in the answer and with `F4`.
- **Front end:** the doctor's card that the pick-type page loads (`MainAppAPI/v1/providers` with
  `retrieval_type: "1"`), although an HTTP 204 answer to it was seen live;
  `appointments/instructions_for_visit_type`, sent as the confirm page loads; and
  `appointments/eligibility`, sent by the modal that comes before the booking pages.
- **Not confirmed:** `appointments/provider_appointments` for a chosen month or a chosen day. No answer
  holding slots was seen live for either.

A month goes out as `YYYYMM`. A day goes out as the UTC instant of local noon on the day picked.

Seen live on 2026-10-26: a recent provider that has no booking type is answered with HTTP 204 and no
provider card.

Left out: `summon_appointment` is the booking itself, sent by nothing but the confirm page's button, and
the client never calls it. `appointments/cpt-to-visit-type` is a query, but no answer to it was ever seen,
so it has no reader.

## Classic server-rendered pages

Code: [member/records.ts](../src/maccabi/member/records.ts),
[member/payments.ts](../src/maccabi/member/payments.ts),
[parse/classic-pages.ts](../src/maccabi/member/parse/classic-pages.ts),
[parse/classic-grids.ts](../src/maccabi/member/parse/classic-grids.ts),
[parse/billing-reports.ts](../src/maccabi/member/parse/billing-reports.ts),
[parse/nursing-reports.ts](../src/maccabi/member/parse/nursing-reports.ts).

These readers take HTML, or HTML wrapped in JSON, from the older part of the portal. A page is decoded only
as UTF-8 or windows-1255. Controls the page hides and the account banners are dropped from results.

- **Hospital history.** Choosing dates inside the page's look-back comes from the page's date picker and
  its controller script. The request for a chosen range is fake only.
- **Quarterly billing.** The catalog returned is the first page Maccabi serves and no more.
- **Nursing-insurance reports.** The catalog and the download from the archive come from the billing page's
  nursing-report script. In a browser the catalog and a PDF matched it; the readers are fake only. Seeing
  a report says nothing about which person the insurance covers.
- **Requests-and-approvals grid, saved documents, purchased medication.** Grids of one family, parsed in
  `classic-grids.ts`, whose comments date what was seen live.

## Mailings

Code: [member/mailings.ts](../src/maccabi/member/mailings.ts),
[parse/mailings.ts](../src/maccabi/member/parse/mailings.ts).

A mailing is one of three kinds, letter types 1 to 3, and the fields checked for each are the ones the
website shows. Kinds 2 and 3 and their PDFs are fake only. A kind-2 download first reads the portal's feature switch, as the website was seen to do, and
takes whichever of two PDF routes it names. The newer route may not have the file ready, so it is asked
again a fixed number of times and then given up.

## Account access and notification settings

Code: [member/account.ts](../src/maccabi/member/account.ts),
[parse/authorized-users.ts](../src/maccabi/member/parse/authorized-users.ts),
[parse/alert-settings.ts](../src/maccabi/member/parse/alert-settings.ts).

- **Who may view the account.** From the account-management (directorship) sub-app: the viewer's state and
  the fields of an authorized user. The call was seen live; the shape of a populated list comes from the front end and is tested on the fake only.
- **Notification settings.** From the scripts of the classic personal-reminders page: the stored groups,
  services and channels. The JSON was seen live in a browser; this client's reader is fake only.

## The portal catalog

Code: [parse/catalog.ts](../src/maccabi/member/parse/catalog.ts),
[member/portal.ts](../src/maccabi/member/portal.ts).

Every entry of `CATALOG` names the portal screen it was taken from and carries its own grade: `live-shape`
when the shape of a real answer is on record, `bundle` when the portal's source is all there is. The whole
catalog was compared with the website's code and with real answers on 2026-10-26; which build that was is
not identified anywhere. What that pass established:

| Where | What the real service did |
| --- | --- |
| `switchit-registrations` | HTTP 405 for the path with no registration id, so the entry always takes one |
| the member profile | HTTP 500 from `MainAppAPI` v3, which sits behind a development flag; the entry stays on v2 |
| `MedicalFileAPI/v1/.../visits` | HTTP 500; the portal's code defines this call and nothing in it uses it |
| `coronaCertificate` | HTTP 500; the website falls back to its generic error popup |
| `eligibilities` | HTTP 403 when `ins_type_code` is `"null"`, even to the body just as the website posts it; same popup |

## The public directory

Code: [provider-directory.ts](../src/maccabi/provider-directory.ts),
[provider-card.ts](../src/maccabi/provider-card.ts).

Read from the public directory site's script: the catalogs, search by name and city, page selection, and a
provider's details. One search covers a single specialty field and may be narrowed by city and by provider
name; results come a page at a time, pages 1 to 1000. Asking for one provider's details repeats the search
it came from and picks the provider out of the new answer by its reference. A result carries contact
details, opening hours, services and remarks. The directory's internal routing values and its links into
booking are left out.

In a browser, search, paging and details were seen live. The reader in this client is tested on the fake,
and a real search made by it remains unconfirmed: the host's bot filter has met it with a robot check where
the entry page was due and where JSON was due. The client stops there, with no second attempt and no
disguise.
