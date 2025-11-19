import FilterBar from '../FilterBar';
import { useState } from 'react';

export default function FilterBarExample() {
  const [category, setCategory] = useState("All Events");

  return (
    <div className="p-6">
      <FilterBar 
        selectedCategory={category}
        onCategoryChange={(cat) => {
          setCategory(cat);
          console.log('Category changed:', cat);
        }}
        onSortChange={(sort) => console.log('Sort changed:', sort)}
      />
    </div>
  );
}
