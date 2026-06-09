package cmd

import (
	"fmt"

	"github.com/hectoropenclaw/mysuperdatabase/cli/internal/config"
	"github.com/spf13/cobra"
)

var linkCmd = &cobra.Command{
	Use:   "link",
	Short: "Link current directory to a mysuperdatabase project",
	RunE: func(cmd *cobra.Command, args []string) error {
		ref, _ := cmd.Flags().GetString("project-ref")
		if ref == "" {
			return fmt.Errorf("--project-ref is required")
		}

		client := mustLoadAPIClient()
		project, err := client.GetProject(ref)
		if err != nil {
			return fmt.Errorf("project not found: %w", err)
		}

		lc := &config.LinkConfig{
			ProjectRef: project.Ref,
			ProjectURL: project.SiteURL,
		}
		if err := config.SaveLink(lc); err != nil {
			return err
		}

		fmt.Printf("✓ Linked to project %s (%s)\n", project.Name, project.Ref)
		fmt.Printf("  URL: %s\n", project.SiteURL)
		return nil
	},
}

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show linked project status",
	RunE: func(cmd *cobra.Command, args []string) error {
		lc, err := loadLink()
		if err != nil {
			return err
		}

		client := mustLoadAPIClient()
		project, err := client.GetProject(lc.ProjectRef)
		if err != nil {
			return err
		}

		fmt.Printf("Project:  %s\n", project.Name)
		fmt.Printf("Ref:      %s\n", project.Ref)
		fmt.Printf("Status:   %s\n", project.Status)
		fmt.Printf("URL:      %s\n", project.SiteURL)
		return nil
	},
}

func init() {
	linkCmd.Flags().StringP("project-ref", "p", "", "Project reference (from: mysuperdatabase projects list)")
	_ = linkCmd.MarkFlagRequired("project-ref")
}

func loadLink() (*config.LinkConfig, error) {
	return config.LoadLink()
}
