import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Activity, LogIn, LogOut, UserPlus, Ban, Flag, Trash2, Check, X, Edit } from "lucide-react";
import AdminLayout from "./AdminLayout";
import { format } from "date-fns";

interface ActivityLog {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: string | null;
  ipAddress: string | null;
  createdAt: string;
  admin: {
    id: string;
    username: string;
    displayName: string;
    role: string;
  };
}

const actionIcons: Record<string, React.ReactNode> = {
  login: <LogIn className="w-4 h-4 text-green-400" />,
  logout: <LogOut className="w-4 h-4 text-slate-400" />,
  create_admin: <UserPlus className="w-4 h-4 text-purple-400" />,
  deactivate_admin: <Ban className="w-4 h-4 text-red-400" />,
  suspend_user: <Ban className="w-4 h-4 text-amber-400" />,
  lift_suspension: <Check className="w-4 h-4 text-green-400" />,
  delete_user: <Trash2 className="w-4 h-4 text-red-400" />,
  approve_event: <Check className="w-4 h-4 text-green-400" />,
  reject_event: <X className="w-4 h-4 text-red-400" />,
  flag_event: <Flag className="w-4 h-4 text-amber-400" />,
  delete_event: <Trash2 className="w-4 h-4 text-red-400" />,
  delete_story: <Trash2 className="w-4 h-4 text-red-400" />,
  review_report: <Flag className="w-4 h-4 text-blue-400" />,
  update_admin: <Edit className="w-4 h-4 text-blue-400" />,
};

const actionLabels: Record<string, string> = {
  login: "Logged in",
  logout: "Logged out",
  create_admin: "Created admin user",
  deactivate_admin: "Deactivated admin",
  suspend_user: "Suspended user",
  lift_suspension: "Lifted suspension",
  delete_user: "Deleted user",
  approve_event: "Approved event",
  reject_event: "Rejected event",
  flag_event: "Flagged event",
  delete_event: "Deleted event",
  delete_story: "Deleted story",
  review_report: "Reviewed report",
  update_admin: "Updated admin",
};

export default function AdminActivity() {
  const { data: logs, isLoading } = useQuery<ActivityLog[]>({
    queryKey: ["/api/admin/activity-logs"],
  });

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Activity Log</h1>
          <p className="text-slate-400 mt-1">
            Track all administrative actions on the platform
          </p>
        </div>

        <Card className="bg-slate-800/50 border-slate-700">
          <CardHeader>
            <CardTitle className="text-white flex items-center gap-2">
              <Activity className="w-5 h-5 text-purple-400" />
              Recent Activity
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-center py-8 text-slate-400">Loading activity...</div>
            ) : logs?.length === 0 ? (
              <div className="text-center py-8 text-slate-400">No activity recorded yet</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-slate-700">
                    <TableHead className="text-slate-400">Action</TableHead>
                    <TableHead className="text-slate-400">Admin</TableHead>
                    <TableHead className="text-slate-400">Target</TableHead>
                    <TableHead className="text-slate-400">Details</TableHead>
                    <TableHead className="text-slate-400">IP Address</TableHead>
                    <TableHead className="text-slate-400">Time</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs?.map((log) => (
                    <TableRow key={log.id} className="border-slate-700">
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {actionIcons[log.action] || <Activity className="w-4 h-4 text-slate-400" />}
                          <span className="text-white">
                            {actionLabels[log.action] || log.action}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div>
                          <p className="text-white">{log.admin.displayName}</p>
                          <p className="text-sm text-slate-400">@{log.admin.username}</p>
                        </div>
                      </TableCell>
                      <TableCell>
                        {log.targetType && log.targetId ? (
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="border-slate-500 text-slate-400">
                              {log.targetType}
                            </Badge>
                            <span className="text-slate-400 text-sm truncate max-w-[80px]">
                              {log.targetId}
                            </span>
                          </div>
                        ) : (
                          <span className="text-slate-500">-</span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[200px]">
                        {log.details ? (
                          <p className="text-slate-400 text-sm truncate" title={log.details}>
                            {log.details}
                          </p>
                        ) : (
                          <span className="text-slate-500">-</span>
                        )}
                      </TableCell>
                      <TableCell className="text-slate-400 text-sm">
                        {log.ipAddress || "-"}
                      </TableCell>
                      <TableCell className="text-slate-400">
                        <div>
                          <p>{format(new Date(log.createdAt), 'MMM d, yyyy')}</p>
                          <p className="text-sm">{format(new Date(log.createdAt), 'h:mm:ss a')}</p>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </AdminLayout>
  );
}
