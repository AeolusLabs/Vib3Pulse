import HeroSection from '../HeroSection';

export default function HeroSectionExample() {
  return (
    <HeroSection
      onSearch={(query) => console.log('Search:', query)}
      onCategoryClick={(cat) => console.log('Category:', cat)}
    />
  );
}
