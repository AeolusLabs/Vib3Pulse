import { useState, useEffect, useRef, useCallback } from "react";
import type { ReactNode } from "react";
import Uppy from "@uppy/core";
import DashboardModal from "@uppy/react/dashboard-modal";
import "@uppy/core/css/style.min.css";
import "@uppy/dashboard/css/style.min.css";
import AwsS3 from "@uppy/aws-s3";
import type { UploadResult } from "@uppy/core";
import { Button } from "@/components/ui/button";

interface ObjectUploaderProps {
  maxNumberOfFiles?: number;
  maxFileSize?: number;
  onGetUploadParameters: () => Promise<{
    method: "PUT";
    url: string;
  }>;
  onComplete?: (
    result: UploadResult<Record<string, unknown>, Record<string, unknown>>
  ) => void;
  buttonClassName?: string;
  buttonVariant?: "default" | "outline" | "ghost" | "secondary";
  buttonSize?: "default" | "sm" | "lg" | "icon";
  children: ReactNode;
  disabled?: boolean;
}

export function ObjectUploader({
  maxNumberOfFiles = 1,
  maxFileSize = 10485760,
  onGetUploadParameters,
  onComplete,
  buttonClassName,
  buttonVariant = "outline",
  buttonSize = "default",
  children,
  disabled = false,
}: ObjectUploaderProps) {
  const [showModal, setShowModal] = useState(false);
  const onGetUploadParametersRef = useRef(onGetUploadParameters);
  const onCompleteRef = useRef(onComplete);

  useEffect(() => {
    onGetUploadParametersRef.current = onGetUploadParameters;
    onCompleteRef.current = onComplete;
  }, [onGetUploadParameters, onComplete]);

  const [uppy] = useState(() =>
    new Uppy({
      restrictions: {
        maxNumberOfFiles,
        maxFileSize,
        allowedFileTypes: ["image/*"],
      },
      autoProceed: false,
    })
      .use(AwsS3, {
        shouldUseMultipart: false,
        getUploadParameters: async () => {
          return await onGetUploadParametersRef.current();
        },
      })
      .on("complete", (result) => {
        onCompleteRef.current?.(result);
        setShowModal(false);
      })
  );

  useEffect(() => {
    return () => {
      uppy.cancelAll();
    };
  }, [uppy]);

  const handleOpen = useCallback(() => {
    uppy.cancelAll();
    setShowModal(true);
  }, [uppy]);

  return (
    <div>
      <Button
        type="button"
        onClick={handleOpen}
        className={buttonClassName}
        variant={buttonVariant}
        size={buttonSize}
        disabled={disabled}
        data-testid="button-upload"
      >
        {children}
      </Button>

      <DashboardModal
        uppy={uppy}
        open={showModal}
        onRequestClose={() => setShowModal(false)}
        proudlyDisplayPoweredByUppy={false}
        theme="auto"
        note="Images only, up to 10 MB"
      />

      <style>{`
        .uppy-Dashboard-inner {
          border-radius: 0.5rem;
          border-color: hsl(var(--border));
          background: hsl(var(--background));
        }
        .uppy-Dashboard-innerWrap {
          background: hsl(var(--background));
        }
        .uppy-Dashboard-AddFiles-title {
          color: hsl(var(--foreground));
        }
        .uppy-Dashboard-browse {
          color: hsl(262 83% 58%);
        }
        .uppy-Dashboard-browse:hover {
          color: hsl(262 83% 50%);
        }
        .uppy-Dashboard-AddFiles-info {
          color: hsl(var(--muted-foreground));
        }
        .uppy-StatusBar {
          background: hsl(var(--muted));
        }
        .uppy-StatusBar-actionBtn--upload {
          background: hsl(262 83% 58%);
          color: white;
        }
        .uppy-StatusBar-actionBtn--upload:hover {
          background: hsl(262 83% 50%);
        }
        .uppy-Dashboard-Item-action--remove {
          color: hsl(var(--destructive));
        }
        .uppy-DashboardContent-bar {
          background: hsl(var(--muted));
          border-color: hsl(var(--border));
        }
        .uppy-DashboardContent-title {
          color: hsl(var(--foreground));
        }
        .uppy-c-btn-primary {
          background: hsl(262 83% 58%);
        }
        .uppy-c-btn-primary:hover {
          background: hsl(262 83% 50%);
        }
        .uppy-Dashboard-Item-name {
          color: hsl(var(--foreground));
        }
        .uppy-Dashboard-Item-statusSize {
          color: hsl(var(--muted-foreground));
        }
        .uppy-Dashboard-dropFilesHereHint {
          color: hsl(262 83% 58%);
          border-color: hsl(262 83% 58%);
        }
        [data-uppy-drag-drop-supported=true] .uppy-Dashboard-AddFiles {
          border-color: hsl(var(--border));
        }
        .uppy-Dashboard-note {
          color: hsl(var(--muted-foreground));
        }
      `}</style>
    </div>
  );
}
