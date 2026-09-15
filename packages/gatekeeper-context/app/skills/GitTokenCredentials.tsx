import { Button, Input, LayerCard, Text, useKumoToastManager } from "@cloudflare/kumo";
import type { ContextGitTokenCreateResult } from "../../src/context-types";

type GitTokenCredentialsProps = {
  token: ContextGitTokenCreateResult;
  branch: string;
};

/** One-time credentials and instructions for configuring a repository push mirror. */
export const GitTokenCredentials = ({ token, branch }: GitTokenCredentialsProps) => {
  const toasts = useKumoToastManager();

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toasts.add({ title: `${label} copied`, variant: "success" });
    } catch {
      toasts.add({ title: `Failed to copy ${label.toLowerCase()}`, variant: "error" });
    }
  };

  return (
    <LayerCard className="flex flex-col gap-4 bg-kumo-control p-4">
      <div>
        <Text bold>Mirror credentials</Text>
        <Text variant="secondary" DANGEROUS_className="mt-1">
          Configure your source repository to push to this generated destination. The password is
          shown only once.
        </Text>
      </div>
      <div className="flex flex-col gap-3">
        <Input label="Username" readOnly value="gitlab" />
        <div className="flex items-end gap-2">
          <Input label="Remote URL" readOnly value={token.remote} className="min-w-0 flex-1 font-mono" />
          <Button variant="secondary" onClick={() => void copy(token.remote, "Remote URL")}>Copy</Button>
        </div>
        <div className="flex items-end gap-2">
          <Input label="Password" readOnly type="password" value={token.plaintext} className="min-w-0 flex-1 font-mono" />
          <Button variant="secondary" onClick={() => void copy(token.plaintext, "Password")}>Copy</Button>
        </div>
      </div>
      <div>
        <Text bold>Set up the mirror</Text>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm leading-5 text-kumo-subtle">
          <li>Open the repository that contains your skills in your Git provider.</li>
          <li>Add a repository mirror using the remote URL and credentials above.</li>
          <li>Choose Push as the mirror direction and select the {branch} branch.</li>
          <li>Trigger the first push, then refresh this collection from its context menu.</li>
        </ol>
      </div>
    </LayerCard>
  );
};
