import { useSuspenseQuery } from '@tanstack/react-query'
import { ErrorComponent, createFileRoute } from '@tanstack/react-router'
import { ValidatorNotFoundError } from '@/api/contracts'
import { constraintsQueryOptions, validatorQueryOptions } from '@/api/queries'
import { Loading } from '@/components/Loading'
import { Meta } from '@/components/Meta'
import { PageMain } from '@/components/PageMain'
import { ValidatorDetails } from '@/components/ValidatorDetails'
import { DetailsHeader } from '@/components/ValidatorDetails/DetailsHeader'

export const Route = createFileRoute('/validators/$validatorId')({
  beforeLoad: () => {
    return {
      validatorQueryOptions,
      constraintsQueryOptions,
    }
  },
  loader: async ({
    context: { queryClient, validatorQueryOptions, constraintsQueryOptions },
    params: { validatorId },
  }) => {
    queryClient.ensureQueryData(validatorQueryOptions(validatorId))
    queryClient.ensureQueryData(constraintsQueryOptions)
  },
  component: Dashboard,
  pendingComponent: () => <Loading size="lg" className="opacity-50" />,
  errorComponent: ({ error }) => {
    if (error instanceof ValidatorNotFoundError) {
      return <div>{error.message}</div>
    }
    return <ErrorComponent error={error} />
  },
})

function Dashboard() {
  const { validatorId } = Route.useParams()
  const validatorQuery = useSuspenseQuery(validatorQueryOptions(validatorId))
  const validator = validatorQuery.data

  const constraintsQuery = useSuspenseQuery(constraintsQueryOptions)
  const constraints = constraintsQuery.data

  const pageTitle = validator.nfd ? validator.nfd.name : `Validator ${validator.id}`

  return (
    <>
      <Meta title={pageTitle} />
      <DetailsHeader validator={validator} />
      <PageMain>
        <ValidatorDetails validator={validator} constraints={constraints} />
      </PageMain>
    </>
  )
}
