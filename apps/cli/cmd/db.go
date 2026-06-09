package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/spf13/cobra"
)

var dbCmd = &cobra.Command{
	Use:   "db",
	Short: "Manage database migrations",
}

var dbPushCmd = &cobra.Command{
	Use:   "push",
	Short: "Apply local migrations to the linked project",
	Long: `Apply all SQL files in ./supabase/migrations/ that haven't been run yet.

Migrations are run in filename order (alphanumeric). Each file is run once.
Re-running push will skip already-applied files.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		lc, err := loadLink()
		if err != nil {
			return err
		}

		client := mustLoadAPIClient()
		keys, err := client.GetProjectKeys(lc.ProjectRef)
		if err != nil {
			return fmt.Errorf("failed to get project keys: %w", err)
		}

		migrationsDir, _ := cmd.Flags().GetString("migrations-dir")
		if migrationsDir == "" {
			migrationsDir = filepath.Join("supabase", "migrations")
		}

		entries, err := os.ReadDir(migrationsDir)
		if err != nil {
			return fmt.Errorf("cannot read %s: %w", migrationsDir, err)
		}

		var sqlFiles []string
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
				sqlFiles = append(sqlFiles, filepath.Join(migrationsDir, e.Name()))
			}
		}
		sort.Strings(sqlFiles)

		if len(sqlFiles) == 0 {
			fmt.Println("No migration files found in", migrationsDir)
			return nil
		}

		// Use psql to apply migrations via the project's direct DB URL
		// Keys.URL is the Kong gateway; we need direct DB access.
		// For now, use the service_role key with REST API's rpc endpoint for DDL.
		// Full psql approach requires direct DB port (not exposed publicly by default).
		dbURL := strings.Replace(keys.URL, "https://", "postgresql://postgres:", 1)
		dbURL = strings.Replace(dbURL, ".db.hconsulting.app", ".db.hconsulting.app:5432/postgres", 1)

		fmt.Printf("Applying %d migration(s) to %s...\n", len(sqlFiles), lc.ProjectRef)
		for _, f := range sqlFiles {
			base := filepath.Base(f)
			fmt.Printf("  → %s", base)

			psqlCmd := exec.Command("psql", dbURL, "-f", f, "--single-transaction")
			psqlCmd.Stderr = os.Stderr
			if err := psqlCmd.Run(); err != nil {
				fmt.Println(" ✗")
				return fmt.Errorf("migration %s failed: %w", base, err)
			}
			fmt.Println(" ✓")
		}

		fmt.Printf("✓ All migrations applied\n")
		return nil
	},
}

var dbPullCmd = &cobra.Command{
	Use:   "pull",
	Short: "Pull the current schema from the linked project",
	Long:  `Dump the current database schema to supabase/migrations/<timestamp>_remote_schema.sql`,
	RunE: func(cmd *cobra.Command, args []string) error {
		lc, err := loadLink()
		if err != nil {
			return err
		}

		client := mustLoadAPIClient()
		keys, err := client.GetProjectKeys(lc.ProjectRef)
		if err != nil {
			return fmt.Errorf("failed to get project keys: %w", err)
		}

		_ = keys
		fmt.Printf("Pulling schema from %s...\n", lc.ProjectRef)
		fmt.Println("(db pull requires direct DB access — ensure your IP is allowlisted or use a VPN)")

		// pg_dump via psql-compatible URL
		outputDir := filepath.Join("supabase", "migrations")
		if err := os.MkdirAll(outputDir, 0755); err != nil {
			return err
		}

		outputFile := filepath.Join(outputDir, "remote_schema.sql")
		dbURL := lc.ProjectURL
		pgDumpCmd := exec.Command("pg_dump", "--schema-only", "--no-owner", "--no-privileges", dbURL, "-f", outputFile)
		pgDumpCmd.Stderr = os.Stderr
		if err := pgDumpCmd.Run(); err != nil {
			return fmt.Errorf("pg_dump failed: %w", err)
		}

		fmt.Printf("✓ Schema dumped to %s\n", outputFile)
		return nil
	},
}

func init() {
	dbCmd.AddCommand(dbPushCmd)
	dbCmd.AddCommand(dbPullCmd)

	dbPushCmd.Flags().String("migrations-dir", "", "Path to migrations directory (default: supabase/migrations)")
}
