---
"@noy-db/cli": patch
---

`noydb config scaffold` emitted import names that no longer exist, so every DynamoDB- or S3-backed profile failed at import. `awsDynamoStore` is `toAwsDynamo` (7 profiles), `awsS3Store` is `toAwsS3` (3 profiles), and `@noy-db/on-oidc` has no `keyConnector` — profile J's commented hint now names `unlockOidc`, the counterpart to the `unlockWebAuthn` line beside it. Option shapes were already correct and are unchanged.
