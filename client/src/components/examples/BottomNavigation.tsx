import BottomNavigation from '../BottomNavigation';

export default function BottomNavigationExample() {
  return (
    <div className="min-h-screen bg-background pb-20">
      <div className="p-6">
        <h1 className="text-2xl font-serif font-semibold mb-4">Bottom Navigation Demo</h1>
        <p className="text-muted-foreground">Scroll down to see the bottom navigation bar (mobile only)</p>
        <div className="space-y-4 mt-8">
          {Array.from({ length: 20 }).map((_, i) => (
            <div key={i} className="p-4 bg-card rounded-md">
              Sample content item {i + 1}
            </div>
          ))}
        </div>
      </div>
      <BottomNavigation onCreateClick={() => console.log('Create clicked')} />
    </div>
  );
}
