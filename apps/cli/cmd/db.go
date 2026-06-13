package cmd

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/spf13/cobra"
)

const (
	defaultMigrationsDir = "supabase/migrations"
	defaultSchemaFile    = "supabase/schema.sql"
	migrationsTable      = "_supanow_migrations"
	bootstrapTable       = "_supanow_bootstrap"
)

var dbCmd = &cobra.Command{
	Use:   "db",
	Short: "Manage database schema and migrations",
}

var dbPushCmd = &cobra.Command{
	Use:   "push",
	Short: "Apply local migrations to the linked project",
	Long: `Apply all SQL files in ./supabase/migrations/ that haven't been run yet.

Migrations are run in filename order and tracked in the project database.
Re-running push will skip already-applied files.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		dbURL, err := resolveLinkedProjectDBURL()
		if err != nil {
			return err
		}

		migrationsDir, _ := cmd.Flags().GetString("migrations-dir")
		if migrationsDir == "" {
			migrationsDir = defaultMigrationsDir
		}

		sqlFiles, err := collectSQLFiles(migrationsDir)
		if err != nil {
			return err
		}
		if len(sqlFiles) == 0 {
			fmt.Println("No migration files found in", migrationsDir)
			return nil
		}

		if err := ensureMetadataTables(dbURL); err != nil {
			return err
		}

		applied, err := getAppliedMigrationSet(dbURL)
		if err != nil {
			return err
		}

		fmt.Printf("Checking %d migration(s)...\n", len(sqlFiles))
		appliedCount := 0
		skippedCount := 0

		for _, f := range sqlFiles {
			base := filepath.Base(f)
			sum, err := fileSHA256(f)
			if err != nil {
				return err
			}

			if existing, ok := applied[base]; ok {
				if existing == sum {
					fmt.Printf("  → %s (already applied)\n", base)
					skippedCount++
					continue
				}
				return fmt.Errorf("migration %s was already applied with a different checksum; create a new migration instead of editing history", base)
			}

			fmt.Printf("  → %s", base)
			if err := runSQLFile(dbURL, f, true); err != nil {
				fmt.Println(" ✗")
				return fmt.Errorf("migration %s failed: %w", base, err)
			}
			if err := recordMigration(dbURL, base, sum); err != nil {
				fmt.Println(" ✗")
				return err
			}
			fmt.Println(" ✓")
			appliedCount++
		}

		fmt.Printf("✓ Done. applied=%d skipped=%d\n", appliedCount, skippedCount)
		return nil
	},
}

var dbBootstrapCmd = &cobra.Command{
	Use:   "bootstrap",
	Short: "Initialize a fresh linked project with a base schema and migrations",
	Long: `Bootstrap a linked project database from a base schema file plus migrations.

Use this for app repos that need a foundational schema before later migrations
can run, such as projects that rely on tables like public.matches existing first.

The schema file is tracked separately so it is only applied once.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		dbURL, err := resolveLinkedProjectDBURL()
		if err != nil {
			return err
		}

		schemaFile, _ := cmd.Flags().GetString("schema-file")
		if schemaFile == "" {
			schemaFile = defaultSchemaFile
		}
		migrationsDir, _ := cmd.Flags().GetString("migrations-dir")
		if migrationsDir == "" {
			migrationsDir = defaultMigrationsDir
		}
		skipSchema, _ := cmd.Flags().GetBool("skip-schema")

		if err := ensureMetadataTables(dbURL); err != nil {
			return err
		}

		if !skipSchema {
			if _, err := os.Stat(schemaFile); err != nil {
				return fmt.Errorf("schema file %s not found; pass --skip-schema or provide --schema-file", schemaFile)
			}

			alreadyBootstrapped, err := isBootstrapApplied(dbURL, schemaFile)
			if err != nil {
				return err
			}
			if alreadyBootstrapped {
				fmt.Printf("Base schema already applied: %s\n", schemaFile)
			} else {
				fmt.Printf("Applying base schema: %s\n", schemaFile)
				if err := runSQLFile(dbURL, schemaFile, false); err != nil {
					return fmt.Errorf("base schema failed: %w", err)
				}
				if err := recordBootstrap(dbURL, schemaFile); err != nil {
					return err
				}
				fmt.Println("✓ Base schema applied")
			}
		}

		return dbPushCmd.RunE(cmd, args)
	},
}

var dbPullCmd = &cobra.Command{
	Use:   "pull",
	Short: "Pull the current schema from the linked project",
	Long:  `Dump the current database schema to supabase/migrations/remote_schema.sql`,
	RunE: func(cmd *cobra.Command, args []string) error {
		dbURL, err := resolveLinkedProjectDBURL()
		if err != nil {
			return err
		}

		lc, err := loadLink()
		if err != nil {
			return err
		}

		fmt.Printf("Pulling schema from %s...\n", lc.ProjectRef)
		fmt.Println("(db pull requires direct DB access — ensure your IP is allowlisted or use a VPN)")

		outputDir := filepath.Join("supabase", "migrations")
		if err := os.MkdirAll(outputDir, 0755); err != nil {
			return err
		}

		outputFile := filepath.Join(outputDir, "remote_schema.sql")
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
	dbCmd.AddCommand(dbBootstrapCmd)
	dbCmd.AddCommand(dbPullCmd)

	dbPushCmd.Flags().String("migrations-dir", "", "Path to migrations directory (default: supabase/migrations)")
	dbBootstrapCmd.Flags().String("schema-file", "", "Path to base schema file (default: supabase/schema.sql)")
	dbBootstrapCmd.Flags().String("migrations-dir", "", "Path to migrations directory (default: supabase/migrations)")
	dbBootstrapCmd.Flags().Bool("skip-schema", false, "Skip applying the base schema file and only run tracked migrations")
}

func resolveLinkedProjectDBURL() (string, error) {
	lc, err := loadLink()
	if err != nil {
		return "", err
	}

	client := mustLoadAPIClient()
	conn, err := client.GetProjectConnectionString(lc.ProjectRef)
	if err != nil {
		return "", fmt.Errorf("failed to get project connection string: %w", err)
	}
	if strings.TrimSpace(conn.URI) == "" {
		return "", fmt.Errorf("project %s does not expose a direct database URI yet", lc.ProjectRef)
	}
	return ensureSSLMode(conn.URI, conn.SSLMode), nil
}

func collectSQLFiles(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("cannot read %s: %w", dir, err)
	}

	var sqlFiles []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			sqlFiles = append(sqlFiles, filepath.Join(dir, e.Name()))
		}
	}
	sort.Strings(sqlFiles)
	return sqlFiles, nil
}

func runPSQL(dbURL string, stdin []byte, args ...string) ([]byte, error) {
	cmd := exec.Command("psql", append([]string{dbURL}, args...)...)
	cmd.Stderr = os.Stderr
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	return cmd.Output()
}

func runSQLFile(dbURL, file string, singleTransaction bool) error {
	args := []string{"-v", "ON_ERROR_STOP=1", "-f", file}
	if singleTransaction {
		args = append(args, "--single-transaction")
	}
	cmd := exec.Command("psql", append([]string{dbURL}, args...)...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func ensureMetadataTables(dbURL string) error {
	sql := fmt.Sprintf(`
CREATE TABLE IF NOT EXISTS public.%s (
  id bigserial PRIMARY KEY,
  filename text NOT NULL UNIQUE,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.%s (
  id bigserial PRIMARY KEY,
  schema_path text NOT NULL UNIQUE,
  applied_at timestamptz NOT NULL DEFAULT now()
);`, migrationsTable, bootstrapTable)
	_, err := runPSQL(dbURL, []byte(sql), "-v", "ON_ERROR_STOP=1", "-q")
	if err != nil {
		return fmt.Errorf("failed to initialize migration metadata tables: %w", err)
	}
	return nil
}

func getAppliedMigrationSet(dbURL string) (map[string]string, error) {
	sql := fmt.Sprintf(`SELECT filename || E'\t' || checksum FROM public.%s ORDER BY id;`, migrationsTable)
	out, err := runPSQL(dbURL, nil, "-At", "-c", sql)
	if err != nil {
		return nil, fmt.Errorf("failed to query applied migrations: %w", err)
	}

	result := map[string]string{}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) != 2 {
			continue
		}
		result[parts[0]] = parts[1]
	}
	return result, nil
}

func recordMigration(dbURL, filename, checksum string) error {
	sql := fmt.Sprintf(`INSERT INTO public.%s(filename, checksum) VALUES ($$%s$$, $$%s$$);`, migrationsTable, filename, checksum)
	_, err := runPSQL(dbURL, nil, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql)
	if err != nil {
		return fmt.Errorf("failed to record migration %s: %w", filename, err)
	}
	return nil
}

func isBootstrapApplied(dbURL, schemaPath string) (bool, error) {
	sql := fmt.Sprintf(`SELECT 1 FROM public.%s WHERE schema_path = $$%s$$ LIMIT 1;`, bootstrapTable, schemaPath)
	out, err := runPSQL(dbURL, nil, "-At", "-c", sql)
	if err != nil {
		return false, fmt.Errorf("failed to query bootstrap state: %w", err)
	}
	return strings.TrimSpace(string(out)) == "1", nil
}

func recordBootstrap(dbURL, schemaPath string) error {
	sql := fmt.Sprintf(`INSERT INTO public.%s(schema_path) VALUES ($$%s$$);`, bootstrapTable, schemaPath)
	_, err := runPSQL(dbURL, nil, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql)
	if err != nil {
		return fmt.Errorf("failed to record bootstrap state: %w", err)
	}
	return nil
}

func fileSHA256(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("failed to read %s: %w", path, err)
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

func ensureSSLMode(rawURL, sslmode string) string {
	if strings.TrimSpace(rawURL) == "" {
		return rawURL
	}
	if strings.TrimSpace(sslmode) == "" {
		sslmode = "require"
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	query := parsed.Query()
	if query.Get("sslmode") == "" {
		query.Set("sslmode", sslmode)
		parsed.RawQuery = query.Encode()
	}
	return parsed.String()
}
