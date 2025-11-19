import TicketSelector from '../TicketSelector';

const mockTiers = [
  {
    id: 'general',
    name: 'General Admission',
    price: 45,
    description: 'Access to main event area',
    available: 150
  },
  {
    id: 'vip',
    name: 'VIP Package',
    price: 95,
    description: 'Premium seating, backstage access, meet & greet',
    available: 25
  },
  {
    id: 'early',
    name: 'Early Bird',
    price: 35,
    description: 'Limited early access tickets',
    available: 10
  }
];

export default function TicketSelectorExample() {
  return (
    <div className="max-w-md p-6">
      <TicketSelector
        tiers={mockTiers}
        onPurchase={(selections) => console.log('Purchased:', selections)}
      />
    </div>
  );
}
