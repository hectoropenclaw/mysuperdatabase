import { ExternalLink } from 'lucide-react'
import { Button } from 'ui'

import type { StepContentProps } from '@/components/interfaces/ConnectSheet/Connect.types'

function ShadcnExploreContent(_props: StepContentProps) {
  return (
    <Button asChild type="default" icon={<ExternalLink size={14} />}>
      <a href="https://db.hconsulting.appm/ui" target="_blank" rel="noreferrer">
        Explore db.hconsulting.appm/ui
      </a>
    </Button>
  )
}

export default ShadcnExploreContent
