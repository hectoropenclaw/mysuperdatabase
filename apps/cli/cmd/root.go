package cmd

import (
	"fmt"
	"os"

	"github.com/hectoropenclaw/mysuperdatabase/cli/internal/api"
	"github.com/hectoropenclaw/mysuperdatabase/cli/internal/config"
	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "mysuperdatabase",
	Short: "mysuperdatabase CLI — manage your projects from the terminal",
	Long: `mysuperdatabase is a CLI for managing your mysuperdatabase projects.

  mysuperdatabase login
  mysuperdatabase projects list
  mysuperdatabase link --project-ref <ref>
  mysuperdatabase functions deploy <slug> --file index.ts
  mysuperdatabase secrets set MY_KEY=myvalue
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
		fmt.Fprintln(os.Stderr, "Not logged in. Run: mysuperdatabase login")
		os.Exit(1)
	}
	return api.New(cfg.APIURL, cfg.APIToken)
}
