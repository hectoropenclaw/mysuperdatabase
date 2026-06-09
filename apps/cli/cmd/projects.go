package cmd

import (
	"fmt"
	"os"
	"text/tabwriter"

	"github.com/hectoropenclaw/supanow/cli/internal/api"
	"github.com/spf13/cobra"
)

var projectsCmd = &cobra.Command{
	Use:     "projects",
	Short:   "Manage your projects",
	Aliases: []string{"project"},
}

var projectsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all projects",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := mustLoadAPIClient()
		projects, err := client.ListProjects()
		if err != nil {
			return err
		}

		if len(projects) == 0 {
			fmt.Println("No projects found. Create one with: supanow projects create")
			return nil
		}

		w := tabwriter.NewWriter(os.Stdout, 0, 0, 3, ' ', 0)
		fmt.Fprintln(w, "REF\tNAME\tSTATUS\tURL")
		for _, p := range projects {
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", p.Ref, p.Name, p.Status, p.SiteURL)
		}
		return w.Flush()
	},
}

var projectsCreateCmd = &cobra.Command{
	Use:   "create <name>",
	Short: "Create a new project",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := mustLoadAPIClient()
		orgID, _ := cmd.Flags().GetString("org-id")

		if orgID == "" {
			orgs, err := client.ListOrgs()
			if err != nil {
				return fmt.Errorf("failed to list orgs: %w", err)
			}
			if len(orgs) == 0 {
				return fmt.Errorf("no organizations found — create one in the dashboard first")
			}
			if len(orgs) == 1 {
				orgID = orgs[0].ID
				fmt.Printf("Using org: %s (%s)\n", orgs[0].Name, orgs[0].Slug)
			} else {
				fmt.Println("Available organizations:")
				for i, o := range orgs {
					fmt.Printf("  %d. %s (%s)\n", i+1, o.Name, o.Slug)
				}
				return fmt.Errorf("multiple orgs found — specify with --org-id")
			}
		}

		project, err := client.CreateProject(api.CreateProjectInput{Name: args[0], OrgID: orgID})
		if err != nil {
			return err
		}

		fmt.Printf("✓ Project created\n")
		fmt.Printf("  ref:    %s\n", project.Ref)
		fmt.Printf("  name:   %s\n", project.Name)
		fmt.Printf("  status: %s (provisioning takes ~30s)\n", project.Status)
		fmt.Printf("\nLink this directory: supanow link --project-ref %s\n", project.Ref)
		return nil
	},
}

var projectsDeleteCmd = &cobra.Command{
	Use:   "delete <ref>",
	Short: "Delete a project (irreversible)",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		confirm, _ := cmd.Flags().GetBool("confirm")
		if !confirm {
			return fmt.Errorf("this is irreversible. Re-run with --confirm to proceed")
		}
		client := mustLoadAPIClient()
		if err := client.DeleteProject(args[0]); err != nil {
			return err
		}
		fmt.Printf("✓ Project %s deleted\n", args[0])
		return nil
	},
}

var projectsApiKeysCmd = &cobra.Command{
	Use:   "api-keys [ref]",
	Short: "Show API keys for a project",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := mustLoadAPIClient()
		ref := ""
		if len(args) > 0 {
			ref = args[0]
		} else {
			lc, err := loadLink()
			if err != nil {
				return err
			}
			ref = lc.ProjectRef
		}

		keys, err := client.GetProjectKeys(ref)
		if err != nil {
			return err
		}

		fmt.Printf("URL:              %s\n", keys.URL)
		fmt.Printf("anon key:         %s\n", keys.AnonKey)
		fmt.Printf("service_role key: %s\n", keys.ServiceRoleKey)
		return nil
	},
}

func init() {
	projectsCmd.AddCommand(projectsListCmd)
	projectsCmd.AddCommand(projectsCreateCmd)
	projectsCmd.AddCommand(projectsDeleteCmd)
	projectsCmd.AddCommand(projectsApiKeysCmd)

	projectsCreateCmd.Flags().String("org-id", "", "Organization ID (auto-selected if you have only one)")
	projectsDeleteCmd.Flags().Bool("confirm", false, "Confirm deletion")
}
