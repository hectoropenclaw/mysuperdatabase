package cmd

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"github.com/hectoropenclaw/supanow/cli/internal/config"
	"github.com/spf13/cobra"
)

var loginCmd = &cobra.Command{
	Use:   "login",
	Short: "Authenticate with supanow",
	Long: `Log in by providing your API token.

Generate a token at: https://app.supanow.com/account/tokens`,
	RunE: func(cmd *cobra.Command, args []string) error {
		tokenFlag, _ := cmd.Flags().GetString("token")
		apiURL, _ := cmd.Flags().GetString("api-url")

		token := tokenFlag
		if token == "" {
			fmt.Print("Enter your API token (from https://app.supanow.com/account/tokens): ")
			reader := bufio.NewReader(os.Stdin)
			t, err := reader.ReadString('\n')
			if err != nil {
				return fmt.Errorf("failed to read token: %w", err)
			}
			token = strings.TrimSpace(t)
		}

		if token == "" {
			return fmt.Errorf("token cannot be empty")
		}

		cfg := &config.Config{
			APIToken: token,
			APIURL:   apiURL,
		}
		if cfg.APIURL == "" {
			cfg.APIURL = config.DefaultAPIURL
		}

		if err := config.Save(cfg); err != nil {
			return fmt.Errorf("failed to save config: %w", err)
		}

		fmt.Println("✓ Logged in successfully")
		return nil
	},
}

func init() {
	loginCmd.Flags().StringP("token", "t", "", "API token (skip interactive prompt)")
	loginCmd.Flags().String("api-url", config.DefaultAPIURL, "Management API URL (for self-hosted deployments)")
}
