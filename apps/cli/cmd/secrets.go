package cmd

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"github.com/hectoropenclaw/supanow/cli/internal/api"
	"github.com/spf13/cobra"
)

var secretsCmd = &cobra.Command{
	Use:   "secrets",
	Short: "Manage project secrets (environment variables for edge functions)",
}

var secretsSetCmd = &cobra.Command{
	Use:   "set [KEY=VALUE ...]",
	Short: "Set one or more secrets",
	Long: `Set secrets as KEY=VALUE pairs.

  supanow secrets set MY_API_KEY=abc123 OTHER_KEY=xyz
  supanow secrets set --env-file .env.production`,
	RunE: func(cmd *cobra.Command, args []string) error {
		client := mustLoadAPIClient()
		ref, err := resolveRefFlag(cmd)
		if err != nil {
			return err
		}

		envFile, _ := cmd.Flags().GetString("env-file")
		var secrets []api.SecretInput

		if envFile != "" {
			parsed, err := parseEnvFile(envFile)
			if err != nil {
				return err
			}
			secrets = append(secrets, parsed...)
		}

		for _, kv := range args {
			parts := strings.SplitN(kv, "=", 2)
			if len(parts) != 2 {
				return fmt.Errorf("invalid format %q — expected KEY=VALUE", kv)
			}
			secrets = append(secrets, api.SecretInput{Name: parts[0], Value: parts[1]})
		}

		if len(secrets) == 0 {
			return fmt.Errorf("no secrets provided — pass KEY=VALUE args or --env-file <path>")
		}

		if err := client.UpsertSecrets(ref, secrets); err != nil {
			return err
		}
		fmt.Printf("✓ %d secret(s) set\n", len(secrets))
		return nil
	},
}

var secretsUnsetCmd = &cobra.Command{
	Use:   "unset [KEY ...]",
	Short: "Delete one or more secrets by name",
	Args:  cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := mustLoadAPIClient()
		ref, err := resolveRefFlag(cmd)
		if err != nil {
			return err
		}

		if err := client.DeleteSecrets(ref, args); err != nil {
			return err
		}
		fmt.Printf("✓ %d secret(s) deleted\n", len(args))
		return nil
	},
}

func parseEnvFile(path string) ([]api.SecretInput, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("cannot open %s: %w", path, err)
	}
	defer f.Close()

	var secrets []api.SecretInput
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		value := strings.Trim(parts[1], `"'`)
		secrets = append(secrets, api.SecretInput{Name: parts[0], Value: value})
	}
	return secrets, scanner.Err()
}

func init() {
	secretsCmd.AddCommand(secretsSetCmd)
	secretsCmd.AddCommand(secretsUnsetCmd)

	secretsSetCmd.Flags().String("project-ref", "", "Project ref (default: linked project)")
	secretsSetCmd.Flags().String("env-file", "", "Load secrets from a .env file")
	secretsUnsetCmd.Flags().String("project-ref", "", "Project ref (default: linked project)")
}
