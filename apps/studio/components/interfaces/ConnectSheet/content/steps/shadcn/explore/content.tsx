import { ExternalLink } from 'lucide-react'
import { Button } from 'ui'

import type { StepContentProps } from '@/components/interfaces/ConnectSheet/Connect.types'

function ShadcnExploreContent(_props: StepContentProps) {
  return (
    <Button asChild type="default" icon={<ExternalLink size={14} />}>
      <a href="https://supanow.com/ui" target="_blank" rel="noreferrer">
        Explore supanow.com/ui
      </a>
    </Button>
  )
}

export default ShadcnExploreContent
