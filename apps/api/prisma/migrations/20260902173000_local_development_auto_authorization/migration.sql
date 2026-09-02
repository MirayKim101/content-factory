-- Local-only authorization evidence. The application accepts this basis only
-- while the fail-closed local-auto runtime policy is active.
ALTER TYPE "SourceAuthorizationBasis" ADD VALUE 'LOCAL_DEVELOPMENT_AUTO';
