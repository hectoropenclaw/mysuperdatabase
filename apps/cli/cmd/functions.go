package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"text/tabwriter"

	"github.com/spf13/cobra"
)

var functionsCmd = &cobra.Command{
	Use:     "functions",
	Short:   "Manage edge functions",
	Aliases: []string{"fn"},
}

var functionsListCmd = &cobra.Command{
	Use:   "list [ref]",
	Short: "List edge functions",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := mustLoadAPIClient()
		ref, err := resolveRef(args)
		if err != nil {
			return err
		}

		fns, err := client.ListFunctions(ref)
		if err != nil {
			return err
		}
		if len(fns) == 0 {
			fmt.Println("No functions deployed.")
			return nil
		}

		w := tabwriter.NewWriter(os.Stdout, 0, 0, 3, ' ', 0)
		fmt.Fprintln(w, "SLUG\tNAME\tSTATUS\tVERIFY_JWT")
		for _, f := range fns {
			verifyJWT := "true"
			if !f.VerifyJWT {
				verifyJWT = "false"
			}
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", f.Slug, f.Name, f.Status, verifyJWT)
		}
		return w.Flush()
	},
}

var functionsDeployCmd = &cobra.Command{
	Use:   "deploy <slug>",
	Short: "Deploy an edge function",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		slug := args[0]
		client := mustLoadAPIClient()
		ref, err := resolveRefFlag(cmd)
		if err != nil {
			return err
		}

		fileFlag, _ := cmd.Flags().GetStringSlice("file")
		noVerifyJWT, _ := cmd.Flags().GetBool("no-verify-jwt")
		dirFlag, _ := cmd.Flags().GetString("dir")
		name, _ := cmd.Flags().GetString("name")
		if name == "" {
			name = slug
		}

		files := map[string]string{}

		if dirFlag != "" {
			err := filepath.Walk(dirFlag, func(path string, info os.FileInfo, err error) error {
				if err != nil || info.IsDir() {
					return err
				}
				data, err := os.ReadFile(path)
				if err != nil {
					return err
				}
				rel, _ := filepath.Rel(dirFlag, path)
				files[rel] = string(data)
				return nil
			})
			if err != nil {
				return fmt.Errorf("reading directory %s: %w", dirFlag, err)
			}
		}

		for _, f := range fileFlag {
			data, err := os.ReadFile(f)
			if err != nil {
				return fmt.Errorf("reading %s: %w", f, err)
			}
			files[filepath.Base(f)] = string(data)
		}

		if len(files) == 0 {
			// Look for index.ts in cwd
			if data, err := os.ReadFile("index.ts"); err == nil {
				files["index.ts"] = string(data)
			} else {
				return fmt.Errorf("no files to deploy — use --file <path> or --dir <directory>")
			}
		}

		fmt.Printf("Deploying function '%s' (%d file(s))...\n", slug, len(files))
		fn, err := client.DeployFunction(ref, slug, name, !noVerifyJWT, files)
		if err != nil {
			return err
		}

		fmt.Printf("✓ Function deployed\n")
		fmt.Printf("  slug:   %s\n", fn.Slug)
		fmt.Printf("  status: %s\n", fn.Status)
		return nil
	},
}

var functionsDeleteCmd = &cobra.Command{
	Use:   "delete <slug>",
	Short: "Delete an edge function",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		slug := args[0]
		client := mustLoadAPIClient()
		ref, err := resolveRefFlag(cmd)
		if err != nil {
			return err
		}

		if err := client.DeleteFunction(ref, slug); err != nil {
			return err
		}
		fmt.Printf("✓ Function '%s' deleted\n", slug)
		return nil
	},
}

func init() {
	functionsCmd.AddCommand(functionsListCmd)
	functionsCmd.AddCommand(functionsDeployCmd)
	functionsCmd.AddCommand(functionsDeleteCmd)

	functionsDeployCmd.Flags().StringSliceP("file", "f", nil, "File(s) to deploy (can be specified multiple times)")
	functionsDeployCmd.Flags().String("dir", "", "Directory containing function files")
	functionsDeployCmd.Flags().String("name", "", "Function display name (defaults to slug)")
	functionsDeployCmd.Flags().String("project-ref", "", "Project ref (default: linked project)")
	functionsDeployCmd.Flags().Bool("no-verify-jwt", false, "Allow unauthenticated requests to this function")

	functionsListCmd.Flags().String("project-ref", "", "Project ref (default: linked project)")
	functionsDeleteCmd.Flags().String("project-ref", "", "Project ref (default: linked project)")
}

func resolveRef(args []string) (string, error) {
	if len(args) > 0 {
		return args[0], nil
	}
	lc, err := loadLink()
	if err != nil {
		return "", err
	}
	return lc.ProjectRef, nil
}

func resolveRefFlag(cmd *cobra.Command) (string, error) {
	ref, _ := cmd.Flags().GetString("project-ref")
	if ref != "" {
		return ref, nil
	}
	lc, err := loadLink()
	if err != nil {
		return "", err
	}
	return lc.ProjectRef, nil
}
