# Manual Pro Grants

This repo supports temporary manual Pro access through a dedicated `users.manualProExpiresAt` field.

## Why this exists

Manual grants are intentionally separate from paid subscriptions:

- Stripe continues to use Stripe subscription state.
- Apple continues to use `subscriptionExpiresAt` from StoreKit.
- Google Play continues to use Play subscription state.
- Manual grants only affect the separate `manualProExpiresAt` field.

This prevents a temporary support grant from interfering with paid billing records.

## Effective entitlement rule

The server computes an effective account level as follows:

1. `enterprise` stays `enterprise`
2. Stored `pro` stays `pro`
3. Stored `basic` becomes effective `pro` only while `manualProExpiresAt` is in the future
4. Expired or missing `manualProExpiresAt` falls back to `basic`

## Operational script

Use `maintenance/grant-temporary-pro.js`.

Examples:

```bash
node maintenance/grant-temporary-pro.js grant --email user@example.com
node maintenance/grant-temporary-pro.js grant --email user@example.com --months 3
node maintenance/grant-temporary-pro.js status --email user@example.com
node maintenance/grant-temporary-pro.js revoke --email user@example.com
```

You can also target by user id:

```bash
node maintenance/grant-temporary-pro.js grant --user-id 123 --months 6
```

## Important operational notes

- The default grant length is 6 months.
- The script updates only `manualProExpiresAt`.
- Do not manually overwrite `accountLevel` for support grants.
- Do not use Apple’s `subscriptionExpiresAt` for manual grants.
- Revoking a manual grant does not cancel or modify any paid subscription.
