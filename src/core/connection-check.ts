import type { ProviderConnectionCheck, ProviderFolderProbe } from "../shared/types.js";
import { abortError } from "./batch.js";
import { FOLDER_ORDER, type MailProvider } from "../providers/provider.js";
import { safeErrorMessage } from "../security/redact.js";

/**
 * Read-only provider readiness check. It verifies folder visibility and basic
 * metadata access only; it never lists message contents or calls a mutation.
 */
export async function checkProviderConnection(
  provider: MailProvider,
  options: { now?: number; signal?: AbortSignal } = {},
): Promise<ProviderConnectionCheck> {
  const signal = options.signal;
  const folders: ProviderFolderProbe[] = [];

  for (const folder of FOLDER_ORDER) {
    if (signal?.aborted) throw abortError();
    const capability = provider.capabilities.folders[folder];
    if (!capability.supported) {
      folders.push({
        folder,
        displayName: capability.displayName,
        accessible: false,
        messageCount: null,
        error: capability.reason ?? "This folder is not supported by the provider integration.",
      });
      continue;
    }
    try {
      const probe = await provider.probeFolder(folder, signal);
      folders.push({
        folder,
        displayName: capability.displayName,
        accessible: probe.accessible,
        messageCount: probe.messageCount,
        error: probe.accessible ? null : "The provider did not report this folder as accessible.",
      });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      folders.push({
        folder,
        displayName: capability.displayName,
        accessible: false,
        messageCount: null,
        error: safeErrorMessage(error),
      });
    }
  }

  const failed = folders.filter((folder) => !folder.accessible);
  const warnings: string[] = [];
  if (failed.length > 0) {
    warnings.push(
      `${failed.length} folder check(s) failed. Review the per-folder errors; the connection may lack a required scope or the account may restrict access.`,
    );
  }
  if (provider.mode === "readonly") {
    warnings.push(
      "This connection is read-only. A passing check confirms reads only; reconnect with cleanup access before executing changes.",
    );
  } else {
    warnings.push(
      "This check is read-only. It does not archive, trash, delete, or test cleanup access beyond folder and metadata reads.",
    );
  }

  return {
    provider: provider.id,
    displayName: provider.capabilities.displayName,
    account: provider.account,
    mode: provider.mode,
    checkedAt: new Date(options.now ?? Date.now()).toISOString(),
    ok: failed.length === 0,
    folders,
    warnings,
    limitations: [
      "No message bodies or attachments are downloaded.",
      "No archive, trash, permanent-delete, or empty-trash operation is exercised.",
      "Message counts are provider estimates or unavailable; they are not a full mailbox inventory.",
      "OAuth scopes are enforced by the provider; this check can only exercise the permissions currently granted.",
    ],
  };
}
