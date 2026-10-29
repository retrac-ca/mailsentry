import type { ActionInfo, CleanupAction, ProviderCapabilities, ProviderId } from "../shared/types.js";

const no = (reason: string, confirmationRequired = false) => ({
  supported: false,
  reason,
  confirmationRequired,
});
const yes = (confirmationRequired = false) => ({
  supported: true,
  confirmationRequired,
});

export const ACTION_INFO: Record<CleanupAction, ActionInfo & { confirmationPhrase: string | null }> = {
  archive: {
    action: "archive",
    label: "Archive",
    description:
      "Remove messages from the Inbox only. Messages remain in the mailbox and can usually be found in All Mail or the Archive folder.",
    destructive: false,
    reversible: true,
    confirmationPhrase: null,
  },
  trash: {
    action: "trash",
    label: "Move to Trash",
    description:
      "Move messages to the provider's Trash / Deleted Items folder. Recovery depends on the provider's retention policy and is not guaranteed.",
    destructive: false,
    reversible: true,
    confirmationPhrase: null,
  },
  permanentDelete: {
    action: "permanentDelete",
    label: "Permanently delete",
    description:
      "Delete selected messages permanently. This cannot be undone by MailSentry and may not be recoverable from the provider.",
    destructive: true,
    reversible: false,
    confirmationPhrase: "DELETE PERMANENTLY",
  },
  emptyTrash: {
    action: "emptyTrash",
    label: "Empty Trash (permanently)",
    description:
      "Permanently delete the eligible messages currently in Trash. Age, size, and bulk filters are not applied to this action; protection rules still apply. This cannot be undone.",
    destructive: true,
    reversible: false,
    confirmationPhrase: "DELETE PERMANENTLY",
  },
};

const GMAIL_CAPABILITIES: ProviderCapabilities = {
  provider: "gmail",
  displayName: "Gmail",
  folders: {
    inbox: { supported: true, displayName: "Inbox", confirmationRequired: false },
    spam: { supported: true, displayName: "Spam", confirmationRequired: false },
    trash: { supported: true, displayName: "Trash", confirmationRequired: false },
  },
  actions: {
    archive: yes(),
    trash: yes(),
    permanentDelete: no(
      "Gmail permanent deletion requires the full-mailbox scope (https://mail.google.com/), which MailSentry does not request. Use the Gmail web interface to empty Trash.",
    ),
    emptyTrash: no(
      "Gmail exposes no empty-trash API and permanent deletion requires the full-mailbox scope. Use the Gmail web interface.",
    ),
  },
  metadata: {
    messageSize: true,
    attachmentSize: false,
    bulkHeaders: true,
  },
  auth: {
    readonlyScope: "https://www.googleapis.com/auth/gmail.readonly",
    cleanupScope: "https://www.googleapis.com/auth/gmail.modify",
  },
};

const MICROSOFT_CAPABILITIES: ProviderCapabilities = {
  provider: "microsoft",
  displayName: "Microsoft 365 / Outlook",
  folders: {
    inbox: { supported: true, displayName: "Inbox", confirmationRequired: false },
    spam: { supported: true, displayName: "Junk Email", confirmationRequired: false },
    trash: { supported: true, displayName: "Deleted Items", confirmationRequired: false },
  },
  actions: {
    archive: yes(),
    trash: yes(),
    permanentDelete: yes(true),
    emptyTrash: yes(true),
  },
  metadata: {
    messageSize: true,
    attachmentSize: false,
    bulkHeaders: false,
  },
  auth: {
    readonlyScope: "Mail.Read",
    cleanupScope: "Mail.ReadWrite",
  },
};

export function capabilitiesFor(provider: ProviderId): ProviderCapabilities {
  if (provider === "gmail") return GMAIL_CAPABILITIES;
  if (provider === "microsoft") return MICROSOFT_CAPABILITIES;
  throw new Error(`Unknown provider: ${String(provider)}`);
}

export function actionInfoFor(action: CleanupAction) {
  return ACTION_INFO[action];
}

export function actionAllowed(provider: ProviderId, action: CleanupAction): boolean {
  return capabilitiesFor(provider).actions[action].supported;
}
