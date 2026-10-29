# Read authorization renewal

A valid local authorization can expire while a read waits for its reservation
lock or commits the durable read budget. An expired, authentic, still-bound
authorization is classified as COST_EXPIRED.

Read reservations renew automatically once outside the reservation lock, with
fresh checks of the current settings and signing key. Every committed reservation
remains counted, including one which expired before the provider request. The
2000-reservation limit and durable mutation budgets are unchanged.

Only a trusted COST_EXPIRED error can trigger the read renewal. Revocation,
configuration changes, invalid signatures, replaced keys, corrupt state and
cancellation stop the operation. Storage creation, upload and translation
reservations keep their non-retrying behavior.

Service and workspace errors preserve COST_UNVERIFIABLE, COST_UNKNOWN and
COST_IDENTITY_MISMATCH. The interface describes the local authorization issue
instead of attributing it to an Autodesk network failure.

A failed model can be resumed from its existing operation. Completed resource
checkpoints are rehashed and reused by the download adapter.

Regression tests cover expiry before and after a budget commit, one-renewal
bounds, preserved counts and limits, mutation expiry, revocation, settings/key
changes and cancellation. The original provider/download/package and workspace
tests remain part of the Node 24 CI validation.
