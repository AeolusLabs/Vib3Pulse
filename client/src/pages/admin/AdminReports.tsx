import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import AdminLayout from "./AdminLayout";
import { format } from "date-fns";
import { CheckIcon, XIcon, EyeIcon, AlertTriangleIcon } from "@/components/ui/icons";

interface ContentReport {
  id: string;
  contentType: string;
  contentId: string;
  reason: string;
  description: string | null;
  status: string;
  createdAt: string;
  reviewedAt: string | null;
  resolution: string | null;
  reporter: {
    id: string;
    username: string;
  };
}

export default function AdminReports() {
  const { toast } = useToast();
  const [selectedTab, setSelectedTab] = useState("pending");
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [selectedReport, setSelectedReport] = useState<ContentReport | null>(null);
  const [resolution, setResolution] = useState("");
  const [reviewStatus, setReviewStatus] = useState<"reviewed" | "dismissed" | "actioned">("reviewed");

  const { data: reports, isLoading } = useQuery<ContentReport[]>({
    queryKey: ["/api/admin/reports", selectedTab],
    queryFn: () => apiRequest("GET", `/api/admin/reports?status=${selectedTab}`).then(r => r.json()),
  });

  const reviewMutation = useMutation({
    mutationFn: async (data: { reportId: string; status: string; resolution?: string }) => {
      const response = await apiRequest("POST", `/api/admin/reports/${data.reportId}/review`, {
        status: data.status,
        resolution: data.resolution,
      });
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Report reviewed",
        description: "The report has been reviewed successfully",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/reports"] });
      setReviewDialogOpen(false);
      setSelectedReport(null);
      setResolution("");
    },
    onError: (error: any) => {
      toast({
        title: "Review failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const filteredReports = reports || [];

  const handleReview = () => {
    if (selectedReport) {
      reviewMutation.mutate({
        reportId: selectedReport.id,
        status: reviewStatus,
        resolution: resolution || undefined,
      });
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return <Badge variant="outline" className="border-amber-500 text-amber-400">Pending</Badge>;
      case "reviewed":
        return <Badge variant="outline" className="border-blue-500 text-blue-400">Reviewed</Badge>;
      case "dismissed":
        return <Badge variant="outline" className="border-slate-500 text-slate-400">Dismissed</Badge>;
      case "actioned":
        return <Badge variant="outline" className="border-green-500 text-green-400">Actioned</Badge>;
      default:
        return <Badge variant="outline" className="border-slate-500 text-slate-400">{status}</Badge>;
    }
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Content Reports</h1>
          <p className="text-slate-400 mt-1">
            Review and resolve user-submitted content reports
          </p>
        </div>

        <Tabs value={selectedTab} onValueChange={setSelectedTab}>
          <TabsList className="bg-slate-800 border border-slate-700">
            <TabsTrigger value="pending" className="data-[state=active]:bg-purple-600">
              Pending
            </TabsTrigger>
            <TabsTrigger value="reviewed" className="data-[state=active]:bg-purple-600">
              Reviewed
            </TabsTrigger>
            <TabsTrigger value="actioned" className="data-[state=active]:bg-purple-600">
              Actioned
            </TabsTrigger>
            <TabsTrigger value="dismissed" className="data-[state=active]:bg-purple-600">
              Dismissed
            </TabsTrigger>
          </TabsList>

          <TabsContent value={selectedTab}>
            <Card className="bg-slate-800/50 border-slate-700">
              <CardContent className="pt-6">
                {isLoading ? (
                  <div className="text-center py-8 text-slate-400">Loading reports...</div>
                ) : filteredReports.length === 0 ? (
                  <div className="text-center py-8 text-slate-400">
                    No {selectedTab} reports found
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow className="border-slate-700">
                        <TableHead className="text-slate-400">Content</TableHead>
                        <TableHead className="text-slate-400">Reporter</TableHead>
                        <TableHead className="text-slate-400">Reason</TableHead>
                        <TableHead className="text-slate-400">Status</TableHead>
                        <TableHead className="text-slate-400">Date</TableHead>
                        <TableHead className="text-slate-400 text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredReports.map((report) => (
                        <TableRow key={report.id} className="border-slate-700">
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className="border-slate-500 text-slate-400">
                                {report.contentType}
                              </Badge>
                              <span className="text-slate-400 text-sm truncate max-w-[100px]">
                                {report.contentId}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="text-slate-300">
                            @{report.reporter.username}
                          </TableCell>
                          <TableCell>
                            <p className="text-white">{report.reason}</p>
                            {report.description && (
                              <p className="text-sm text-slate-400 truncate max-w-[200px]">
                                {report.description}
                              </p>
                            )}
                          </TableCell>
                          <TableCell>{getStatusBadge(report.status)}</TableCell>
                          <TableCell className="text-slate-400">
                            {format(new Date(report.createdAt), 'MMM d, yyyy')}
                          </TableCell>
                          <TableCell className="text-right">
                            {report.status === "pending" && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-purple-400 hover:text-purple-300"
                                onClick={() => {
                                  setSelectedReport(report);
                                  setReviewDialogOpen(true);
                                }}
                                data-testid={`button-review-report-${report.id}`}
                              >
                                <EyeIcon className="w-4 h-4 mr-1" /> Review
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <Dialog open={reviewDialogOpen} onOpenChange={setReviewDialogOpen}>
          <DialogContent className="bg-slate-800 border-slate-700">
            <DialogHeader>
              <DialogTitle className="text-white">Review Report</DialogTitle>
              <DialogDescription className="text-slate-400">
                Review this content report and take appropriate action.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="p-4 bg-slate-700/50 rounded-lg space-y-2">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="border-slate-500 text-slate-400">
                    {selectedReport?.contentType}
                  </Badge>
                  <span className="text-slate-400 text-sm">{selectedReport?.contentId}</span>
                </div>
                <p className="text-white font-medium">{selectedReport?.reason}</p>
                {selectedReport?.description && (
                  <p className="text-slate-400">{selectedReport?.description}</p>
                )}
                <p className="text-sm text-slate-500">
                  Reported by @{selectedReport?.reporter.username}
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-slate-300">Resolution Status</Label>
                <Select value={reviewStatus} onValueChange={(v: any) => setReviewStatus(v)}>
                  <SelectTrigger className="bg-slate-700/50 border-slate-600 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-800 border-slate-700">
                    <SelectItem value="reviewed">Reviewed (No action needed)</SelectItem>
                    <SelectItem value="actioned">Actioned (Content removed/user warned)</SelectItem>
                    <SelectItem value="dismissed">Dismissed (False report)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label className="text-slate-300">Resolution Notes</Label>
                <Textarea
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                  placeholder="Add notes about how this was resolved..."
                  className="bg-slate-700/50 border-slate-600 text-white"
                  data-testid="input-resolution-notes"
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setReviewDialogOpen(false)}
                className="border-slate-600"
              >
                Cancel
              </Button>
              <Button
                onClick={handleReview}
                disabled={reviewMutation.isPending}
                className="bg-purple-600 hover:bg-purple-700"
                data-testid="button-submit-review"
              >
                {reviewMutation.isPending ? "Submitting..." : "Submit Review"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
