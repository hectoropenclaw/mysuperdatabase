package cmd

import (
	"fmt"
	"os"

	"github.com/hectoropenclaw/supanow/cli/internal/api"
	"github.com/hectoropenclaw/supanow/cli/internal/config"
	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "supanow",
	Short: "supanow CLI — manage your projects from the terminal",
	Long: `supanow is a CLI for managing your supanow projects.

  supanow login
  supanow projects list
  supanow link --project-ref <ref>
  supanow db bootstrap
  supanow db push
  supanow functions deploy <slug> --file index.ts
  supanow secrets set MY_KEY=myvalue
`,
	SilenceErrors: true,
	SilenceUsage:  true,
}

func Execute() error {
	return rootCmd.Execute()
}

func init() {
	rootCmd.AddCommand(loginCmd)
	rootCmd.AddCommand(projectsCmd)
	rootCmd.AddCommand(linkCmd)
	rootCmd.AddCommand(statusCmd)
	rootCmd.AddCommand(functionsCmd)
	rootCmd.AddCommand(secretsCmd)
	rootCmd.AddCommand(dbCmd)
}

// mustLoadAPIClient loads config and returns an API client.
// Exits with a helpful message if not logged in.
func mustLoadAPIClient() *api.Client {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "Error loading config:", err)
		os.Exit(1)
	}
	if cfg.APIToken == "" {
		fmt.Fprintln(os.Stderr, "Not logged in. Run: supanow login")
		os.Exit(1)
	}
	return api.New(cfg.APIURL, cfg.APIToken)
}
