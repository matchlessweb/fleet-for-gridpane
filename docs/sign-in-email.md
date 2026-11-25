# Changing the sign-in email

A signed-in person changes their sign-in email under Settings, Profile.

1. They type the new address. Fleet asks for a passkey first if the last strong sign-in (a passkey, or a password plus a code) is more than ten minutes old.
   If the account also has an authenticator app, Supabase wants that app's code before it will change an email, even after a passkey sign-in. Fleet asks for the code in the same panel and then sends the change; nobody has to sign out.
2. Supabase mails a confirmation link to the new address. The account keeps its old address.
3. The link opens Fleet's confirm page. The address changes only when they press **Confirm new address** there.

The rules and their tests are in `lib/account/email-change.ts` and `scripts/test-email-change.ts` (`npm run account:test`).

## Set up in Supabase

Fleet does not send email itself. Supabase does, so three settings in the Supabase project decide how well this works.

**Point the "Change Email Address" template at Fleet's confirm page.** In the template, replace `{{ .ConfirmationURL }}` with:

```
{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email_change
```

A script makes that one change and nothing else. Run it from this folder, on a Mac signed in to the Supabase CLI:

```
bash scripts/set-email-change-template.sh            # look: shows these settings, changes nothing
bash scripts/set-email-change-template.sh --apply    # changes the link, then reads it back
```

A new Supabase project has its Site URL at `http://localhost:3000`, and the script stops there. Add `--site-url` with this Fleet's own address to set it in the same step:

```
bash scripts/set-email-change-template.sh --apply --site-url https://fleet.example.com
```

It sends one field (the body of that one message), or two with `--site-url`, leaves a message without a `{{ .ConfirmationURL }}` link alone, and stops if the Site URL is not an https address. Its checks: `bash scripts/test-set-email-change-template.sh`.

Without this the feature still works, but Supabase's own link confirms the address the moment anything fetches it, including a mail scanner or a link preview. With it, fetching the link changes nothing: only the button on Fleet's page confirms.

**Set the Site URL to this Fleet's address** (Authentication, URL Configuration). The template line above is built from it.

**Keep "Secure email change" on** (Authentication, Email). Supabase is reachable on its own, so someone holding a stolen session could ask it for an email change without coming through Fleet's passkey check. With this setting on, the old address has to confirm as well, and that is what covers the case. Fleet's confirm page handles both links and says when one step is left.

Two more that are worth having:

- **An email sender (custom SMTP).** Supabase's built-in sender only writes to the project's own team and allows a few messages an hour. Fleet says so plainly when a change is refused for that reason.
- **The "Email address changed" security notification.** It is off by default. Turned on, the old address is told after a change.

## What the first account needs

The first account is often created with a placeholder address. Supabase cannot confirm a change away from an address that receives no mail when "Secure email change" is on, so set the first real address once with the admin API (`PUT /auth/v1/admin/users/<id>` with `email` and `email_confirm: true`, using the service-role key). After that, changes go through the profile page. Until it is done, the profile page says so: when Supabase refuses to send to the current address, Fleet names that address and points here.
