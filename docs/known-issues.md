# Known issues

Failures seen against the live service and understood. Each one comes back with `known_issue` in its error,
so an agent can pass the sentence on instead of retrying. "The website too" means the Maccabi website was
checked with the same session and fails the same way.

## Maccabi's side (`cause: maccabi`)

| Command | Error | What happens | Retry |
| --- | --- | --- | --- |
| `lab-values-pdf` | `PORTAL_HTTP_ERROR`, `report-absent` | Maccabi may not serve the printable report of an older laboratory result. The website's Print button may get the same refusal. The values are in `lab-values`. | no |
| `lab-history-pdf` | `PORTAL_HTTP_ERROR`, `status=404` | Maccabi may refuse the history print of some tests; the website may too. The values are in `lab-history`. | no |
| `portal --endpoint service-eligibilities` | `HTTP_REFUSED`, `status=403` | Refused for some accounts, also to the website's own request; the website shows a try-again-later message. | no |
| `portal-document --endpoint vaccination-groups` | `PORTAL_REPORTED_ERROR`, `maccabi-error-page:document-cannot-be-opened` | Maccabi answers its "error opening document" page for the COVID vaccination print; the website's print button gets the same page. Only COVID groups have a document reference: the website offers that print for them only. Doses are in `vaccine-doses`; the certificate is `vaccine-certificate-pdf`. | no |
| `directory-search`, `directory-provider` | `LISTING_CHALLENGED` | The public directory may screen automated clients. Its specialty and city lists have answered, but searches may get a robot check. The tool does not get around it; the member can search the directory on the Maccabi website. | no |

## Nothing to show (`cause: not-applicable`)

| Command | Error | What happens |
| --- | --- | --- |
| `clinic-visit`, `clinic-visit-summary-pdf` | `NOT_OFFERED`, `summary-absent` | The visit has no summary file (`has_summary_pdf: false`); the website does not open one either. |
| `billing-totals` | `NOT_OFFERED`, `payer-is-member` | The member is their own payer, so there are no payer totals. |
| `prescription-pdf` | `NOT_OFFERED`, `not-a-live-digital-prescription` | Only current digital prescriptions have a document. |
| `prescription-substitutes` | `NOT_OFFERED`, `not-purchasable-now` | Alternatives exist only for prescriptions that can be bought now. |
| `lab-history-pdf --view graph` | `NOT_ENTITLED` | The website hides the graph for these tests too (no reference range and no value). |
| `portal --endpoint corona-certificate` | `PORTAL_HTTP_ERROR`, `status=500` | Maccabi answers a server error when there is no COVID certificate; the website shows its generic error. |
| `hospital-visits` | `NOT_OFFERED`, `range-*` | The portal looks back three years at most; the error names the earliest date. |

## Network (`cause: network`)

| Command | Error | What happens |
| --- | --- | --- |
| `directory-*` | `LISTING_UNREACHABLE` | The public directory host `serguide.maccabi4u.co.il` could not be reached. Some sandboxes and firewalls block it; it works from an ordinary connection. |
| any | `TIMED_OUT`, `UNREACHABLE` | Maccabi did not answer in time, or the connection dropped. Can happen on any call, more often on long lists and the imaging viewer's sign-in; the next call usually works. |

## Mistakes that look like failures (`cause: caller`)

| Symptom | What went wrong | Fix |
| --- | --- | --- |
| `NOT_THE_MEMBERS`, `reference-unknown` | A reference saved from an earlier call. Document references change between calls. | Run the list again and copy the reference from the fresh result. |
| `NOT_THE_MEMBERS`, `provider-unknown` | A team member or the assigned doctor passed to `provider`, `visit-types`, `booking-eligibility` or `open-slots`. | Use `object_type`, `object_id`, `employee_id` of a `recent-providers` row (or `bookable-providers` `providers[].row`). |
| `NOT_THE_MEMBERS` on `scan` | A `test-results` `request_id` used as a study UID. | Use the `request_id` of a `scans` row. |

## Removed reads

`test-information` and `medicine-name` were portal reads that the website reaches only from landing pages a
Maccabi SMS or message opens, with codes no list provides; every id an agent could pass answered HTTP errors.
Test values are in `lab-values` and `lab-history`; medicine names in `prescriptions` and
`pharmacy-purchases`.
