import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ConversationTurnFileChangesProjection } from "@rah/runtime-protocol";
import { ReviewDialog } from "./ReviewDialog";
import type { ReviewScope } from "./ReviewSurface";

export type ReviewOverlayRequest = {
  scope: ReviewScope;
  initialPath?: string;
};

export type ReviewOverlayOwner =
  | { kind: "session"; sessionId: string }
  | { kind: "workspace"; workspaceRoot: string }
  | null;

type ReviewOverlayController = {
  openReview: (request: ReviewOverlayRequest) => void;
  closeReview: () => void;
  retainReviewForOwner: (owner: ReviewOverlayOwner) => void;
  updateOpenTurnReview: (
    sessionId: string,
    turnId: string,
    fileChanges: ConversationTurnFileChangesProjection,
  ) => void;
};

const NOOP_REVIEW_OVERLAY: ReviewOverlayController = {
  openReview: () => undefined,
  closeReview: () => undefined,
  retainReviewForOwner: () => undefined,
  updateOpenTurnReview: () => undefined,
};

const ReviewOverlayContext = createContext<ReviewOverlayController | null>(null);

export function reviewRequestBelongsToOwner(
  request: ReviewOverlayRequest,
  owner: ReviewOverlayOwner,
): boolean {
  if (!owner) {
    return false;
  }
  if (owner.kind === "session") {
    return request.scope.sessionId === owner.sessionId;
  }
  return (
    request.scope.kind === "workspace" &&
    request.scope.sessionId === null &&
    request.scope.workspaceRoot === owner.workspaceRoot
  );
}

export function ReviewOverlayProvider(props: { children: ReactNode }) {
  const [request, setRequest] = useState<ReviewOverlayRequest | null>(null);
  const openReview = useCallback((nextRequest: ReviewOverlayRequest) => {
    setRequest(nextRequest);
  }, []);
  const closeReview = useCallback(() => {
    setRequest(null);
  }, []);
  const retainReviewForOwner = useCallback((owner: ReviewOverlayOwner) => {
    setRequest((current) =>
      current && reviewRequestBelongsToOwner(current, owner) ? current : null,
    );
  }, []);
  const updateOpenTurnReview = useCallback(
    (
      sessionId: string,
      turnId: string,
      fileChanges: ConversationTurnFileChangesProjection,
    ) => {
      setRequest((current) => {
        if (
          current?.scope.kind !== "turn" ||
          current.scope.sessionId !== sessionId ||
          current.scope.turnId !== turnId ||
          (current.scope.files === fileChanges.files &&
            current.scope.totalAdditions === fileChanges.totalAdditions &&
            current.scope.totalDeletions === fileChanges.totalDeletions)
        ) {
          return current;
        }
        return {
          ...current,
          scope: {
            ...current.scope,
            files: fileChanges.files,
            totalAdditions: fileChanges.totalAdditions,
            totalDeletions: fileChanges.totalDeletions,
          },
        };
      });
    },
    [],
  );
  const controller = useMemo(
    () => ({ closeReview, openReview, retainReviewForOwner, updateOpenTurnReview }),
    [closeReview, openReview, retainReviewForOwner, updateOpenTurnReview],
  );

  return (
    <ReviewOverlayContext.Provider value={controller}>
      {props.children}
      {request ? (
        <ReviewDialog
          scope={request.scope}
          {...(request.initialPath ? { initialPath: request.initialPath } : {})}
          onClose={closeReview}
        />
      ) : null}
    </ReviewOverlayContext.Provider>
  );
}

export function useReviewOverlay(): ReviewOverlayController {
  return useContext(ReviewOverlayContext) ?? NOOP_REVIEW_OVERLAY;
}
